import type { Metadata } from "next";
import Link from "next/link";
import { HOSTED_FEE_PCT, site } from "@/lib/site";

export const metadata: Metadata = { title: "Best sandbox for the job" };

/** Enough digits to tell sub-cent runs apart. */
const money = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : n >= 0.001 ? `$${n.toFixed(4)}` : `$${n.toFixed(6)}`);
/** A fixed charge: "$0.01". */
const fee = (n: number) => `$${Number(n.toPrecision(2))}`;
const perHour = (n: number) => `$${n >= 1 ? n.toFixed(2) : Number(n.toPrecision(3))}/h`;
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
const runLength = (s: number) => (s < 60 ? plural(s, "second") : s < 3600 ? plural(Math.round(s / 60), "minute") : plural(Math.round(s / 3600), "hour"));
const shortDay = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export default function RankingsPage() {
  const fastest = site.leaderboard
    .filter((r) => r.medianCreateMs !== undefined && r.successRate >= 0.8)
    .sort((a, b) => a.medianCreateMs! - b.medianCreateMs!)
    .slice(0, 5);

  return (
    <div className="px-5 sm:px-10 pt-14">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">Rankings</p>
      <h1 className="mt-5 max-w-2xl text-4xl font-normal leading-[1.08] tracking-[-0.035em] sm:text-[44px]">Best sandbox for the job</h1>
      <p className="mt-5 max-w-2xl text-[15px] leading-7 text-ink-2">
        The cheapest provider depends on how long you use it. A provider that charges a full minute loses on a 10-second job and
        wins on a 30-minute one. Each list is what that run would be billed, ranked the way the router ranks it, among providers that
        passed the <Link href="/providers" className="underline underline-offset-4 decoration-line-2">real-account check</Link>.
      </p>

      <div className="mt-10 grid grid-cols-1 gap-x-10 gap-y-12 lg:grid-cols-2">
        {site.useCases.map((u) => (
          <section key={u.id} id={u.id} className="scroll-mt-20">
            <h2 className="text-xl font-normal tracking-[-0.02em]">{u.title}</h2>
            <p className="mt-1 text-[14px] text-ink-2">{u.blurb}</p>
            <p className="mt-1 font-mono text-[11px] text-muted">
              {u.spec.vcpu} vCPU / {u.spec.memoryGb} GB · {runLength(u.runSeconds)}
              {u.require.length ? ` · needs ${u.require.join(", ")}` : ""}
            </p>
            <table className="mt-4 w-full text-[14px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-[0.12em] text-muted">
                  <th className="w-8 py-2 pr-2 font-normal">#</th>
                  <th className="py-2 pr-4 font-normal">Provider</th>
                  <th className="py-2 pr-4 text-right font-normal">This run</th>
                  <th className="hidden py-2 text-right font-normal sm:table-cell">Per hour, this run</th>
                </tr>
              </thead>
              <tbody>
                {u.top.map((r, i) => {
                  const why = [
                    r.minimumSeconds > u.runSeconds ? `bills at least ${r.minimumSeconds} s` : "",
                    r.perSandboxUsd ? `+${fee(r.perSandboxUsd)} per sandbox` : "",
                  ].filter(Boolean);
                  return (
                    <tr key={r.provider} className="border-t border-line">
                      <td className="py-2.5 pr-2 font-mono text-[12px] text-muted">{i + 1}</td>
                      <td className="py-2.5 pr-4">
                        <Link href={`/providers/${r.provider}`} className="text-ink hover:underline underline-offset-4 decoration-line-2">
                          {r.name}
                        </Link>
                        {why.length ? <span className="ml-2 text-[12px] text-muted">{why.join(", ")}</span> : null}
                      </td>
                      <td className="py-2.5 pr-4 text-right font-mono tnum text-ink">{money(r.runUsd)}</td>
                      <td className="hidden py-2.5 text-right font-mono tnum text-ink-2 sm:table-cell">{perHour(r.runHourlyUsd)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        ))}

        {fastest.length > 0 && (
          <section id="fastest" className="scroll-mt-20">
            <h2 className="text-xl font-normal tracking-[-0.02em]">Fastest start</h2>
            <p className="mt-1 text-[14px] text-ink-2">When the wait matters more than the price: median cold start in our benchmark.</p>
            <p className="mt-1 font-mono text-[11px] text-muted">from a laptop in Europe · see dates</p>
            <table className="mt-4 w-full text-[14px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-[0.12em] text-muted">
                  <th className="w-8 py-2 pr-2 font-normal">#</th>
                  <th className="py-2 pr-4 font-normal">Provider</th>
                  <th className="py-2 pr-4 text-right font-normal">Cold start</th>
                  <th className="hidden py-2 text-right font-normal sm:table-cell">Measured</th>
                </tr>
              </thead>
              <tbody>
                {fastest.map((r, i) => (
                  <tr key={r.provider} className="border-t border-line">
                    <td className="py-2.5 pr-2 font-mono text-[12px] text-muted">{i + 1}</td>
                    <td className="py-2.5 pr-4">
                      <Link href={`/providers/${r.provider}`} className="text-ink hover:underline underline-offset-4 decoration-line-2">
                        {r.name}
                      </Link>
                    </td>
                    <td className="py-2.5 pr-4 text-right font-mono tnum text-ink">{r.medianCreateMs!.toLocaleString("en-US")} ms</td>
                    <td className="hidden py-2.5 text-right tnum text-ink-2 sm:table-cell">{shortDay(r.measuredAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>

      <section className="prose-sr mt-16 max-w-2xl border-t border-line pt-10">
        <h2>How these are ranked</h2>
        <p>
          Each provider&apos;s list price for the size, corrected where we measured what it really bills, then its billing rules over
          the run: the minimum it charges, the steps it bills in, and any fixed charge per sandbox. That&apos;s the same number the
          router ranks by, so <code>{`router.create({ expectedSeconds: 10 })`}</code> picks the top of the first list. Fixed-size
          providers (E2B, OpenScale, Daytona) can&apos;t give these sizes and aren&apos;t listed. Disk, network and monthly plans are left
          out. On the hosted key, add {HOSTED_FEE_PCT}% to providers you don&apos;t bring your own key for.
        </p>
        <p>
          Start times depend on where you run them; the <Link href="/benchmarks">benchmarks</Link> page has every provider and how
          they were measured.
        </p>
      </section>
    </div>
  );
}
