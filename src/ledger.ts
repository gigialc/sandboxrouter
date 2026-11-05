import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ProviderId } from "./types.js";

/** One sandbox the router started and hasn't seen killed. */
export interface LedgerEntry {
  /** Routed id, `provider:nativeId`. */
  id: string;
  provider: ProviderId;
  /** ISO time the create returned. */
  createdAt: string;
  /** ISO time its requested lifetime (spec.timeoutMinutes) runs out. */
  expiresAt: string;
  /** Estimated list price per hour while it runs. */
  usdHour: number;
}

type Line = ({ op: "open" } & LedgerEntry) | { op: "close"; id: string; at: string; why: string };

/**
 * Where the default ledger lives: $SANDBOXROUTER_HOME/sandboxes.jsonl, else ~/.sandboxrouter/.
 * Returns null when SANDBOXROUTER_LEDGER=off.
 */
export function defaultLedgerFile(): string | null {
  if (/^(off|0|false|no)$/i.test(process.env.SANDBOXROUTER_LEDGER ?? "")) return null;
  return join(process.env.SANDBOXROUTER_HOME || join(homedir(), ".sandboxrouter"), "sandboxes.jsonl");
}

/**
 * A local record of every sandbox this machine's routers created, so a crashed script's sandboxes
 * can still be found and killed (`sandboxrouter ls` / `gc`). Append-only JSON lines, so several
 * processes can write at once; `compact()` rewrites it with only the open entries.
 * Writing never throws: a ledger problem must not break creating or killing a sandbox.
 */
export class Ledger {
  private warned = false;

  constructor(readonly file: string) {}

  open(e: LedgerEntry): void {
    this.append({ op: "open", ...e });
  }

  close(id: string, why = "killed"): void {
    this.append({ op: "close", id, at: new Date().toISOString(), why });
  }

  /** Open entries, oldest first. */
  list(): LedgerEntry[] {
    const open = new Map<string, LedgerEntry>();
    for (const line of this.lines()) {
      if (line.op === "open") {
        const { op: _op, ...e } = line;
        open.set(e.id, e);
      } else open.delete(line.id);
    }
    return [...open.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Rewrite the file with only the open entries. */
  compact(): void {
    const keep = this.list().map((e) => JSON.stringify({ op: "open", ...e })).join("\n");
    try {
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, keep ? `${keep}\n` : "", { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      this.warn(err);
    }
  }

  private lines(): Line[] {
    if (!existsSync(this.file)) return [];
    const out: Line[] = [];
    for (const raw of readFileSync(this.file, "utf8").split("\n")) {
      if (!raw.trim()) continue;
      try {
        const l = JSON.parse(raw);
        if ((l?.op === "open" || l?.op === "close") && typeof l.id === "string") out.push(l);
      } catch {
        // A line cut short by a crash: skip it.
      }
    }
    return out;
  }

  private append(line: Line): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      appendFileSync(this.file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    } catch (err) {
      this.warn(err);
    }
  }

  private warn(err: unknown) {
    if (this.warned) return;
    this.warned = true;
    console.warn(`sandboxrouter: couldn't write the sandbox ledger at ${this.file}: ${(err as Error).message}`);
  }
}
