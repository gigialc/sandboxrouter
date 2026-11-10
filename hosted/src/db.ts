/** Postgres access: node-postgres in production, PGlite (in-process Postgres) for tests and local runs. */
export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Run fn in one transaction. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Money is integer micro-dollars (1 USD = 1,000,000) everywhere, so sums never drift. */
export const MICROS = 1_000_000;

export const SCHEMA = `
create table if not exists users (
  id text primary key,
  login text not null,
  email text,
  blocked boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists sessions (
  hash text primary key,
  user_id text not null references users(id),
  expires_at timestamptz not null
);
create table if not exists api_keys (
  id text primary key,
  user_id text not null references users(id),
  hash text not null unique,
  prefix text not null,
  name text not null default '',
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create table if not exists sandboxes (
  id text primary key,
  user_id text not null references users(id),
  provider text not null,
  list_hourly_usd double precision not null,
  rate_micros bigint not null,
  started_at timestamptz not null,
  billed_until timestamptz not null,
  expires_at timestamptz not null,
  ended_at timestamptz,
  end_reason text
);
create index if not exists sandboxes_running on sandboxes (user_id) where ended_at is null;
create table if not exists ledger (
  id bigserial primary key,
  user_id text not null references users(id),
  kind text not null,
  amount_micros bigint not null,
  ref text unique,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists ledger_user on ledger (user_id, created_at desc);
`;

/** `pglite:` (in memory) or `pglite:./dir` for PGlite; anything else is a Postgres URL. */
export async function openDb(url: string): Promise<Db> {
  const db = url.startsWith("pglite:") ? await pglite(url.slice(7) || undefined) : await postgres(url);
  await db.query(SCHEMA);
  return db;
}

async function pglite(dir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = new PGlite(dir);
  type Q = { query: (s: string, p?: unknown[]) => Promise<{ rows: any[] }>; exec?: (s: string) => Promise<unknown> };
  const wrap = (q: Q, inTx: boolean): Db => {
    const db: Db = {
      // PGlite's query() takes one statement; exec() runs a script (the schema).
      query: async (sql, params) => (params?.length || !q.exec ? q.query(sql, params) : ((await q.exec(sql)) as any[]).at(-1) ?? { rows: [] }),
      tx: (fn) => (inTx ? fn(db) : (pg.transaction((t) => fn(wrap(t as unknown as Q, true))) as any)),
      close: () => pg.close(),
    };
    return db;
  };
  return wrap(pg as unknown as Q, false);
}

async function postgres(url: string): Promise<Db> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  return {
    query: (sql, params) => pool.query(sql, params as any[]) as any,
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const inner: Db = { query: (s, p) => client.query(s, p as any[]) as any, tx: (f) => f(inner), close: async () => {} };
        const out = await fn(inner);
        await client.query("commit");
        return out;
      } catch (err) {
        await client.query("rollback").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
