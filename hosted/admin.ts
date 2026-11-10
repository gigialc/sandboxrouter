/**
 * Operator commands against the hosted database (DATABASE_URL):
 *   npm run admin -- users
 *   npm run admin -- grant <github-login> <usd> [note]
 *   npm run admin -- block <github-login>      the meter kills their sandboxes within a minute
 *   npm run admin -- unblock <github-login>
 */
import { addCredit, balance, userByLogin } from "./src/accounts.js";
import { MICROS, openDb } from "./src/db.js";

const [cmd, login, amount, ...note] = process.argv.slice(2);
const db = await openDb(process.env.DATABASE_URL ?? "pglite:./.data");
const user = login ? await userByLogin(db, login) : undefined;
if (login && !user) throw new Error(`no user ${login}`);

if (cmd === "users") {
  const { rows } = await db.query(
    `select u.login, u.email, u.blocked, coalesce(sum(l.amount_micros), 0) as balance,
            (select count(*) from sandboxes s where s.user_id = u.id and s.ended_at is null) as running
     from users u left join ledger l on l.user_id = u.id group by u.id order by u.created_at`,
  );
  console.table(rows.map((r) => ({ login: r.login, email: r.email, blocked: r.blocked, balance: (Number(r.balance) / MICROS).toFixed(4), running: Number(r.running) })));
} else if (cmd === "grant" && user && amount) {
  await addCredit(db, user.id, "grant", Number(amount) * MICROS, `grant:${user.id}:${Date.now()}`, note.join(" ") || "credit from sandboxrouter");
  console.log(`${user.login}: balance $${((await balance(db, user.id)) / MICROS).toFixed(4)}`);
} else if ((cmd === "block" || cmd === "unblock") && user) {
  await db.query("update users set blocked = $2 where id = $1", [user.id, cmd === "block"]);
  console.log(`${user.login} ${cmd}ed`);
} else {
  console.log("usage: admin users | grant <login> <usd> [note] | block <login> | unblock <login>");
  process.exitCode = 2;
}
await db.close();
