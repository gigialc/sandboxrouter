import type { Metadata } from "next";
import Link from "next/link";
import { TaskTable } from "@/components/TaskTable";
import { UseCaseTable } from "@/components/UseCaseTable";
import { site, usd } from "@/lib/site";

export const metadata: Metadata = { title: "Benchmarks" };

const ms = (n?: number) => (n === undefined ? "n/a" : `${n.toLocaleString("en-US")} ms`);
const cents = (n: number | null) => (n === null ? "n/a" : n === 0 ? "$0" : `$${n < 0.01 ? n.toFixed(4) : n.toFixed(3)}`);
const shortDay = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

export default function BenchmarksPage() {
  const rows = site.leaderboard;
  const subs = [...site.submissions].sort((a, b) => b.date.localeCompare(a.date));
  const totalRuns = subs.reduce((n, s) => n + s.runs * s.providers, 0);
  const maxCreate = Math.max(1, ...rows.map((r) => r.medianCreateMs ?? 0));
  const maxExec = Math.max(1, ...rows.map((r) => r.medianExecMs ?? 0));
  const costs = site.costRuns.filter((r) => !r.error && r.billedUsd !== null && r.billedUsd > 0);

  return (
    <div className="px-5 sm:px-10 pt-14">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">Benchmarks</p>
      <h1 className="mt-5 max-w-2xl text-4xl font-normal leading-[1.08] tracking-[-0.035em] sm:text-[44px]">
        What each sandbox costs, and how fast it starts
      </h1>
      <p className="mt-5 max-w-2xl text-[15px] leading-7 text-ink-2">
        Real sandboxes on real accounts, started, used and killed. <Link href="/methodology#pricing" className="text-ink underline underline-offset-4 decoration-line-2 hover:decoration-ink">How the numbers are made</Link>.
      </p>

      <section id="cost" className="mt-14 scroll-mt-20">
        <h2 className="text-2xl font-normal tracking-[-0.025em] sm:text-[28px]">Cost for the job</h2>
        <p className="mt-3 mb-6 max-w-2xl text-[14px] leading-6 text-ink-2">
          The cheapest provider depends on how long you use it. Tested providers, ranked by what each job would be billed.{" "}
          <Link href="/methodology#pricing" className="text-ink underline underline-offset-4 decoration-line-2 hover:decoration-ink">How it&apos;s measured</Link>.
        </p>
        <UseCaseTable />
      </section>

      {site.tasks.kinds.length > 0 && (
        <section id="task" className="mt-20 scroll-mt-20">
          <h2 className="text-2xl font-normal tracking-[-0.025em] sm:text-[28px]">Cost of a real task</h2>
          <p className="mt-3 max-w-2xl text-[14px] leading-6 text-ink-2">
            The same job on every provider, priced by how long it really took. Hover a time for each step. <Link href="/methodology#jobs" className="text-ink underline underline-offset-4 decoration-line-2 hover:decoration-ink">How it&apos;s measured</Link>.
          </p>
          <TaskTable />
        </section>
      )}

      <section id="speed" className="mt-20 scroll-mt-20">
      <h2 className="text-2xl font-normal tracking-[-0.025em] sm:text-[28px]">Speed</h2>
      <p className="mt-3 max-w-2xl text-[14px] leading-6 text-ink-2">
        {rows.length} providers, {totalRuns} sandboxes{subs[0] ? `, last run ${day(subs[0].date)}` : ""}. <Link href="/methodology#speed" className="text-ink underline underline-offset-4 decoration-line-2 hover:decoration-ink">How it&apos;s measured</Link>.
      </p>

      <table className="mt-6 w-full text-[14px]">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-[0.12em] text-muted">
            <th className="py-3 pr-4 font-normal">Provider</th>
            <th className="py-3 pr-4 font-normal">Cold start (median)</th>
            <th className="hidden py-3 pr-4 font-normal sm:table-cell">Command round trip</th>
            <th className="hidden py-3 pr-4 font-normal md:table-cell">Succeeded</th>
            <th className="hidden py-3 pr-4 font-normal md:table-cell">Size</th>
            <th className="hidden py-3 pr-4 font-normal lg:table-cell">Measured</th>
            <th className="py-3 font-normal">List price</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.provider} className="group border-t border-line">
              <td className="py-3 pr-4">
                <Link href={`/providers/${r.provider}`} className="text-ink group-hover:underline underline-offset-4 decoration-line-2">
                  {r.name}
                </Link>
              </td>
              <td className="py-3 pr-4">
                <div className="flex items-center gap-3" title={`${r.name}: median cold start ${ms(r.medianCreateMs)}`}>
                  <span className="w-20 font-mono tnum text-ink">{ms(r.medianCreateMs)}</span>
                  <span className="hidden h-px w-28 bg-line sm:block">
                    <span className="block h-px bg-bar" style={{ width: `${((r.medianCreateMs ?? 0) / maxCreate) * 100}%` }} />
                  </span>
                </div>
              </td>
              <td className="hidden py-3 pr-4 sm:table-cell">
                <div className="flex items-center gap-3" title={`${r.name}: median command round trip ${ms(r.medianExecMs)}`}>
                  <span className="w-20 font-mono tnum text-ink-2">{ms(r.medianExecMs)}</span>
                  <span className="hidden h-px w-20 bg-line lg:block">
                    <span className="block h-px bg-bar" style={{ width: `${((r.medianExecMs ?? 0) / maxExec) * 100}%` }} />
                  </span>
                </div>
              </td>
              <td className="hidden py-3 pr-4 font-mono tnum text-ink-2 md:table-cell">{Math.round(r.successRate * 100)}%</td>
              <td className="hidden py-3 pr-4 font-mono tnum text-ink-2 md:table-cell">
                {r.size.vcpu} vCPU / {r.size.memoryGb} GB
              </td>
              <td className="hidden py-3 pr-4 tnum text-ink-2 lg:table-cell">{shortDay(r.measuredAt)}</td>
              <td className="py-3 font-mono tnum text-ink-2">{usd(r.hourlyUsd)}/hr</td>
            </tr>
          ))}
        </tbody>
      </table>
      </section>

      {costs.length > 0 && (
        <section id="real-cost" className="mt-20 scroll-mt-20">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-accent">Real cost</p>
          <h2 className="mt-3 text-2xl font-normal tracking-[-0.025em] sm:text-[28px]">What providers actually billed</h2>
          <p className="mt-4 max-w-2xl text-[14px] leading-6 text-ink-2">
            A sandbox ran for a fixed time; the bill came from the provider&apos;s own billing API. <Link href="/methodology#bills" className="text-ink underline underline-offset-4 decoration-line-2 hover:decoration-ink">How it&apos;s measured</Link>.
          </p>
          <div className="mt-6 overflow-x-auto">
            <table className="w-full min-w-[560px] text-[14px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-[0.12em] text-muted">
                  <th className="py-3 pr-4 font-normal">Provider</th>
                  <th className="py-3 pr-4 font-normal">Ran</th>
                  <th className="py-3 pr-4 font-normal">List price said</th>
                  <th className="py-3 pr-4 font-normal">Billed</th>
                  <th className="py-3 font-normal">Measured</th>
                </tr>
              </thead>
              <tbody>
                {costs.map((r) => (
                  <tr key={`${r.date}-${r.provider}`} className="border-t border-line">
                    <td className="py-3 pr-4">
                      <Link href={`/providers/${r.provider}`} className="text-ink hover:underline underline-offset-4 decoration-line-2">
                        {r.name}
                      </Link>
                    </td>
                    <td className="py-3 pr-4 font-mono tnum text-ink-2">{r.seconds === null ? "n/a" : `${Math.round(r.seconds / 60)} min`}</td>
                    <td className="py-3 pr-4 font-mono tnum text-ink-2">{cents(r.predictedUsd)}</td>
                    <td className="py-3 pr-4 font-mono tnum text-ink">{cents(r.billedUsd)}</td>
                    <td className="py-3 tnum text-ink-2">{shortDay(r.date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

        </section>
      )}

      <p className="mt-16 border-t border-line pt-8 text-[14px] text-ink-2">
        <Link href="/methodology#runs" className="text-ink underline underline-offset-4 decoration-line-2 hover:decoration-ink">Where these ran, and how to add your own run</Link>.
      </p>
    </div>
  );
}
