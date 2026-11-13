// Turns the nightly check's reports into a short note for a person: what broke, which accounts are out
// of credit, what only failed once. Prints nothing when there's nothing to say, so no email goes out.
//   node --import tsx scripts/live-check-email.ts <reports.json> <run url>
// LAST_NOTE (env) is the previous note: when it listed problems and tonight has none, an all-clear is
// printed instead of nothing, so the last email is never a stale alarm.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CheckReport } from "../src/check.js";

/** Ends every note that lists problems, so the next run knows the last email was an alarm. */
export const PROBLEMS_MARK = "<!-- live-check: problems -->";

export function note(reports: (CheckReport & { firstTry?: string })[], runUrl: string, lastNote = "", date = new Date()): string {
  const day = date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  const firstFail = (r: CheckReport) => {
    const f = r.results.find((x) => x.status === "fail");
    return f ? `${f.step}: ${clean(r.provider, f.detail ?? "failed")}` : "failed";
  };
  const broken = reports.filter((r) => !r.ok && !r.inconclusive);
  const unpaid = reports.filter((r) => r.inconclusive?.includes("402"));
  const noPackage = reports.filter((r) => r.inconclusive && !r.inconclusive.includes("402"));
  const flaky = reports.filter((r) => r.ok && r.firstTry);
  const fine = reports.filter((r) => r.ok && !r.firstTry);
  const total = reports.length;

  if (!broken.length && !unpaid.length && !noPackage.length) {
    if (!lastNote.includes(PROBLEMS_MARK)) return "";
    return [`**Nightly check, ${day}: all ${total} providers pass again.**`, "", `Details: ${runUrl}`].join("\n") + "\n";
  }

  const need = broken.length + unpaid.length + noPackage.length;
  const lines = [`**Nightly check, ${day}: ${need} of ${total} provider${total === 1 ? "" : "s"} need${need === 1 ? "s" : ""} a look.**`, ""];
  if (broken.length) {
    lines.push("**Broken** (failed twice in a row):");
    for (const r of broken) lines.push(`- ${r.provider}: ${firstFail(r)}`);
    lines.push("");
  }
  if (unpaid.length) {
    lines.push("**Out of credit** (the account couldn't pay, so the check didn't run):");
    for (const r of unpaid) {
      const why = r.results.find((x) => x.status === "skip" && x.detail?.includes("402"))?.detail ?? r.inconclusive ?? "";
      lines.push(`- ${r.provider}: ${clean(r.provider, why.replace(/^the account can't pay \(402\), so this run says nothing about \S+: /, ""))}`);
    }
    lines.push("");
  }
  if (noPackage.length) {
    lines.push("**Not run** (the check's machine is missing the provider's package; a fix in the workflow, not the provider):");
    for (const r of noPackage) lines.push(`- ${r.provider}: ${r.inconclusive}`);
    lines.push("");
  }
  if (flaky.length) {
    lines.push("**Passed on the second try** (probably a one-off):");
    for (const r of flaky) lines.push(`- ${r.provider}: first try ${r.firstTry}`);
    lines.push("");
  }
  if (fine.length) lines.push(`**Fine:** ${fine.map((r) => r.provider).join(", ")}`, "");
  lines.push(`Details: ${runUrl}`, "", PROBLEMS_MARK);
  return lines.join("\n") + "\n";
}

/** One line, without the "all providers failed: daytona: daytona: 402:" prefixes the error picks up on its way out. */
const clean = (provider: string, s: string) => {
  let t = s.replace(/\s+/g, " ").trim().replace(/^all providers failed: /, "").replace(/\. This looks like a setup problem with .*$/, "");
  for (let prev = ""; prev !== t; ) {
    prev = t;
    t = t.startsWith(`${provider}: `) ? t.slice(provider.length + 2) : t.replace(/^\d{3}: /, "");
  }
  return t.length > 200 ? `${t.slice(0, 197)}...` : t;
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [file, runUrl = ""] = process.argv.slice(2);
  if (!file) throw new Error("usage: live-check-email.ts <reports.json> <run url>");
  process.stdout.write(note(JSON.parse(readFileSync(file, "utf8")), runUrl, process.env.LAST_NOTE ?? ""));
}
