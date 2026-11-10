import type { RoutedSandbox, Router, RouteOptions, SandboxSpec } from "../../src/index.js";
import { HttpError } from "../../src/index.js";
import { balance, type User } from "./accounts.js";
import { MICROS, type Db } from "./db.js";

export interface Limits {
  /** Added to the provider's list price, in percent (OpenRouter charges 5.5% on credits). */
  feePct: number;
  /** Sandboxes one user may run at once. */
  maxConcurrent: number;
  /** A sandbox can't start below this balance, in USD. */
  minBalanceUsd: number;
  /** Longest a sandbox may live; the requested timeoutMinutes is capped to it. */
  maxLifetimeMinutes: number;
  maxVcpu: number;
  maxMemoryGb: number;
}

export const DEFAULT_LIMITS: Limits = {
  feePct: 5.5,
  maxConcurrent: 5,
  minBalanceUsd: 0.1,
  maxLifetimeMinutes: 240,
  maxVcpu: 8,
  maxMemoryGb: 16,
};

/**
 * Charges each running sandbox its list price plus the fee, by the second, against the owner's
 * prepaid balance. `tick()` runs every minute: it bills time since the last tick, kills sandboxes
 * past their lifetime, and kills everything a user runs once their balance is gone or they're blocked.
 */
export class Meter {
  constructor(
    private readonly db: Db,
    private readonly router: Router,
    readonly limits: Limits = DEFAULT_LIMITS,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async beforeCreate(user: User, spec: SandboxSpec, route: RouteOptions) {
    if (user.blocked) throw new HttpError(403, "this account is blocked; write to the address on the dashboard");
    const l = this.limits;
    if ((spec.vcpu ?? 2) > l.maxVcpu || (spec.memoryGb ?? 4) > l.maxMemoryGb) {
      throw new HttpError(400, `the hosted API runs sandboxes up to ${l.maxVcpu} vCPU / ${l.maxMemoryGb} GB`);
    }
    if ((await balance(this.db, user.id)) < l.minBalanceUsd * MICROS) {
      throw new HttpError(402, "out of credit: add credit on the dashboard");
    }
    const running = Number((await this.db.query("select count(*) as n from sandboxes where user_id = $1 and ended_at is null", [user.id])).rows[0].n);
    if (running >= l.maxConcurrent) throw new HttpError(429, `at most ${l.maxConcurrent} sandboxes at once; kill one first`);
    spec.timeoutMinutes = Math.max(1, Math.min(spec.timeoutMinutes ?? 30, l.maxLifetimeMinutes));
    void route;
  }

  async afterCreate(user: User, sbx: RoutedSandbox, spec: SandboxSpec) {
    const now = this.now();
    const expires = new Date(now.getTime() + (spec.timeoutMinutes ?? 30) * 60_000);
    await this.db.query(
      `insert into sandboxes (id, user_id, provider, list_hourly_usd, rate_micros, started_at, billed_until, expires_at)
       values ($1, $2, $3, $4, $5, $6, $6, $7)`,
      [sbx.id, user.id, sbx.provider, sbx.estimatedHourlyUsd, this.rate(sbx.estimatedHourlyUsd), now, expires],
    );
  }

  /** Micro-dollars per hour for a list price, fee included. */
  rate(listHourlyUsd: number): number {
    return Math.round(listHourlyUsd * MICROS * (1 + this.limits.feePct / 100));
  }

  async owns(user: User, id: string): Promise<boolean> {
    const { rows } = await this.db.query("select 1 from sandboxes where id = $1 and user_id = $2 and ended_at is null", [id, user.id]);
    return rows.length > 0;
  }

  /** Bill up to `at` (never past the sandbox's lifetime) and mark it ended. */
  async end(id: string, reason: string, at = this.now()) {
    await this.db.tx(async (db) => {
      await this.bill(db, id, at);
      await db.query("update sandboxes set ended_at = least($2::timestamptz, expires_at), end_reason = $3 where id = $1 and ended_at is null", [id, at, reason]);
    });
  }

  private async bill(db: Db, id: string, at: Date) {
    const { rows } = await db.query(
      "select user_id, rate_micros, billed_until, expires_at from sandboxes where id = $1 and ended_at is null for update",
      [id],
    );
    const s = rows[0];
    if (!s) return;
    const until = new Date(Math.min(at.getTime(), new Date(s.expires_at).getTime()));
    const seconds = (until.getTime() - new Date(s.billed_until).getTime()) / 1000;
    if (seconds <= 0) return;
    const cost = Math.round((Number(s.rate_micros) * seconds) / 3600);
    // One usage row per sandbox, growing as it runs, so the ledger stays readable.
    await db.query(
      `insert into ledger (user_id, kind, amount_micros, ref, note) values ($1, 'usage', $2, $3, $4)
       on conflict (ref) do update set amount_micros = ledger.amount_micros + excluded.amount_micros`,
      [s.user_id, -cost, `usage:${id}`, id],
    );
    await db.query("update sandboxes set billed_until = $2 where id = $1", [id, until]);
  }

  private async kill(id: string, reason: string, at: Date) {
    try {
      await (await this.router.get(id)).kill();
    } catch {
      // Already gone at the provider (its own lifetime ran out) or unreachable; billing stops either way.
    }
    await this.end(id, reason, at);
  }

  async tick(): Promise<{ billed: number; killed: string[] }> {
    const now = this.now();
    const running = (await this.db.query<{ id: string; expires_at: Date }>("select id, expires_at from sandboxes where ended_at is null")).rows;
    const killed: string[] = [];
    for (const s of running) {
      if (new Date(s.expires_at) <= now) {
        await this.kill(s.id, "lifetime", now);
        killed.push(s.id);
      } else {
        await this.db.tx((db) => this.bill(db, s.id, now));
      }
    }
    const broke = (
      await this.db.query<{ id: string; reason: string }>(
        `select s.id, case when u.blocked then 'blocked' else 'out of credit' end as reason
         from sandboxes s join users u on u.id = s.user_id
         where s.ended_at is null
           and (u.blocked or (select coalesce(sum(amount_micros), 0) from ledger l where l.user_id = s.user_id) <= 0)`,
      )
    ).rows;
    for (const s of broke) {
      await this.kill(s.id, s.reason, now);
      killed.push(s.id);
    }
    return { billed: running.length, killed };
  }
}
