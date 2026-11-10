import { createHash, randomBytes } from "node:crypto";
import type { Db } from "./db.js";

export interface User {
  id: string;
  login: string;
  email: string | null;
  blocked: boolean;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const token = (bytes: number) => randomBytes(bytes).toString("base64url");

/** API keys look like `sr_live_<32 random chars>`; only a SHA-256 of the key is stored. */
export const KEY_PREFIX = "sr_live_";

export async function upsertUser(db: Db, u: { id: string; login: string; email?: string | null }): Promise<User> {
  const { rows } = await db.query<User>(
    `insert into users (id, login, email) values ($1, $2, $3)
     on conflict (id) do update set login = excluded.login, email = coalesce(excluded.email, users.email)
     returning id, login, email, blocked`,
    [u.id, u.login, u.email ?? null],
  );
  return rows[0];
}

export async function userByLogin(db: Db, login: string): Promise<User | undefined> {
  return (await db.query<User>("select id, login, email, blocked from users where lower(login) = lower($1)", [login])).rows[0];
}

// --- browser sessions (the dashboard) -----------------------------------------------------------

export const SESSION_DAYS = 30;

export async function createSession(db: Db, userId: string): Promise<string> {
  const t = token(32);
  await db.query("insert into sessions (hash, user_id, expires_at) values ($1, $2, now() + make_interval(days => $3))", [sha256(t), userId, SESSION_DAYS]);
  return t;
}

export async function userFromSession(db: Db, t: string | undefined): Promise<User | undefined> {
  if (!t) return undefined;
  const { rows } = await db.query<User>(
    `select u.id, u.login, u.email, u.blocked from sessions s join users u on u.id = s.user_id
     where s.hash = $1 and s.expires_at > now()`,
    [sha256(t)],
  );
  return rows[0];
}

export async function endSession(db: Db, t: string | undefined) {
  if (t) await db.query("delete from sessions where hash = $1", [sha256(t)]);
}

// --- API keys -----------------------------------------------------------------------------------

export interface ApiKey {
  id: string;
  prefix: string;
  name: string;
  created_at: Date;
  last_used_at: Date | null;
}

export async function createKey(db: Db, userId: string, name = ""): Promise<{ key: string } & ApiKey> {
  const key = KEY_PREFIX + token(24);
  const id = token(9);
  const { rows } = await db.query<ApiKey>(
    "insert into api_keys (id, user_id, hash, prefix, name) values ($1, $2, $3, $4, $5) returning id, prefix, name, created_at, last_used_at",
    [id, userId, sha256(key), key.slice(0, KEY_PREFIX.length + 4), name.slice(0, 60)],
  );
  return { key, ...rows[0] };
}

export async function listKeys(db: Db, userId: string): Promise<ApiKey[]> {
  return (
    await db.query<ApiKey>(
      "select id, prefix, name, created_at, last_used_at from api_keys where user_id = $1 and revoked_at is null order by created_at",
      [userId],
    )
  ).rows;
}

export async function revokeKey(db: Db, userId: string, id: string): Promise<boolean> {
  const { rows } = await db.query("update api_keys set revoked_at = now() where id = $1 and user_id = $2 and revoked_at is null returning id", [id, userId]);
  return rows.length > 0;
}

/** The user an `Authorization: Bearer sr_live_...` header belongs to, if the key is live. */
export async function userFromKey(db: Db, key: string): Promise<User | undefined> {
  if (!key.startsWith(KEY_PREFIX)) return undefined;
  const { rows } = await db.query<User>(
    `update api_keys k set last_used_at = now() from users u
     where k.hash = $1 and k.revoked_at is null and u.id = k.user_id
     returning u.id, u.login, u.email, u.blocked`,
    [sha256(key)],
  );
  return rows[0];
}

// --- money --------------------------------------------------------------------------------------

/** Credits minus usage, in micro-dollars. */
export async function balance(db: Db, userId: string): Promise<number> {
  const { rows } = await db.query("select coalesce(sum(amount_micros), 0) as b from ledger where user_id = $1", [userId]);
  return Number(rows[0].b);
}

/**
 * Add a ledger row (positive = credit). `ref` makes it idempotent: a Stripe event delivered twice
 * credits once. Returns false if that ref was already recorded.
 */
export async function addCredit(db: Db, userId: string, kind: "topup" | "grant" | "refund", micros: number, ref: string, note = ""): Promise<boolean> {
  const { rows } = await db.query(
    "insert into ledger (user_id, kind, amount_micros, ref, note) values ($1, $2, $3, $4, $5) on conflict (ref) do nothing returning id",
    [userId, kind, Math.round(micros), ref, note],
  );
  return rows.length > 0;
}
