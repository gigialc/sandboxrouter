import type { Metadata } from "next";
import { PageHeader } from "@/components/chrome";
import Link from "next/link";
import { AgentTable } from "@/components/AgentTable";
import { LoadTable } from "@/components/LoadTable";
import { TaskTable } from "@/components/TaskTable";
import { UseCaseTable } from "@/components/UseCaseTable";
import { site, usd } from "@/lib/site";

export const metadata: Metadata = { title: "Benchmarks" };

const ms = (n?: number) => (n === undefined ? "n/a" : `${n.toLocaleString("en-US")} ms`);
const cents = (n: number | null) => (n === null ? "n/a" : n === 0 ? "$0" : `$${n < 0.01 ? n.toFixed(4) : n.toFixed(3)}`);
const shortDay = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
/** One section: its title, one line, a link to how it's measured, then its table. */
function Section({ id, title, how, children, line }: { id: string; title: string; how: string; line: React.ReactNode; children: React.ReactNode }) {
  return (
    <section id={id} className="mt-20 scroll-mt-32 first-of-type:mt-12">
      <h2 className="text-2xl font-normal tracking-[-0.025em] sm:text-[28px]">{title}</h2>
      <p className="mt-3 max-w-2xl text-[14px] leading-6 text-ink-2">
        {line}{" "}
        <Link href={`/methodology#${how}`} className="text-ink underline underline-offset-4 decoration-line-2 hover:decoration-ink">
          How it&apos;s measured
        </Link>
        .
      </p>
      {children}
    </section>
  );
}

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

export default function BenchmarksPage() {
  const rows = site.leaderboard;
  const subs = [...site.submissions].sort((a, b) => b.date.localeCompare(a.date));
  const totalRuns = subs.reduce((n, s) => n + s.runs * s.providers, 0);
  const maxCreate = Math.max(1, ...rows.map((r) => r.medianCreateMs ?? 0));
  const maxExec = Math.max(1, ...rows.map((r) => r.medianExecMs ?? 0));
  const costs = site.costRuns.filter((r) => !r.error && r.billedUsd !== null && r.billedUsd > 0);
  // A fixed charge per sandbox isn't running time: shown apart, and taken out of the ratio the router uses.
  const feeOf = (id: string) => site.providers.find((p) => p.id === id)?.pricing.perSandboxUsd ?? 0;
  const vsList = (r: (typeof costs)[number]) =>
    r.predictedUsd ? `${Math.round((((r.billedUsd ?? 0) - feeOf(r.provider)) / r.predictedUsd) * 100)}%` : "n/a";

  return (
    <div className="px-5 sm:px-10 pt-14">
      <PageHeader kicker="Benchmarks" title="What each sandbox costs, and how it performs">
        Real sandboxes on real accounts, started, used and killed: {totalRuns.toLocaleString("en-US")} so far.
      </PageHeader>

      {/* One line of links to every section, so the page reads as a list of answers. */}
      <nav aria-label="On this page" className="sticky top-14 z-10 -mx-5 mt-10 border-y border-line bg-bg/95 px-5 py-3 backdrop-blur sm:-mx-10 sm:px-10">
        <ul className="flex gap-5 overflow-x-auto whitespace-nowrap text-[13px] text-ink-2">
          {[
            ["cost", "Cost for the job"],
            ["task", "Real work"],
            ...(site.agent.length ? [["agent", "A real agent"]] : []),
            ...(site.load.length ? [["load", "Under load"]] : []),
            ["speed", "Start time"],
            ["real-cost", "Bills"],
          ].map(([id, label]) => (
            <li key={id}>
              <a href={`#${id}`} className="hover:text-ink">
                {label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <Section id="cost" title="Cost for the job" how="pricing" line="The cheapest provider depends on how long you use it: tested providers, ranked by what each job would be billed.">
        <div className="mt-6">
          <UseCaseTable />
        </div>
      </Section>

      {site.tasks.kinds.length > 0 && (
        <Section id="task" title="Real work" how="jobs" line="The same job on every provider, from a short burst of CPU to installing a real repo, priced by how long it really took.">
          <TaskTable />
        </Section>
      )}

      {site.agent.length > 0 && (
        <Section id="agent" title="A real agent" how="agent" line="A real model does the same task in a sandbox on each provider, with one tool that runs commands there.">
          <AgentTable />
        </Section>
      )}

      {site.load.length > 0 && (
        <Section id="load" title="Under load" how="load" line="100 sandboxes asked for at once: how many start, how fast, and what all of them cost.">
          <LoadTable />
        </Section>
      )}

      <Section
        id="speed"
        title="Start time"
        how="speed"
        line={`${rows.length} providers${subs[0] ? `, last run ${day(subs[0].date)}` : ""}: time to a usable sandbox, one at a time.`}
      >

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
      </Section>

      {costs.length > 0 && (
        <Section id="real-cost" title="Bills" how="bills" line="What providers actually billed for a sandbox run for a fixed time, read from their own billing APIs.">
          <div className="mt-6 overflow-x-auto">
            <table className="w-full min-w-[560px] text-[14px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-[0.12em] text-muted">
                  <th className="py-3 pr-4 font-normal">Provider</th>
                  <th className="py-3 pr-4 font-normal">Ran</th>
                  <th className="py-3 pr-4 font-normal">List price said</th>
                  <th className="py-3 pr-4 font-normal">Billed</th>
                  <th className="py-3 pr-4 font-normal">Running time vs list</th>
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
                    <td className="py-3 pr-4 font-mono tnum text-ink">
                      {cents(r.billedUsd)}
                      {feeOf(r.provider) ? <span className="ml-1 text-[11px] text-muted">incl. {cents(feeOf(r.provider))} start fee</span> : null}
                    </td>
                    <td className="py-3 pr-4 font-mono tnum text-ink-2">{vsList(r)}</td>
                    <td className="py-3 tnum text-ink-2">{shortDay(r.date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      <p className="mt-16 border-t border-line pt-8 text-[14px] text-ink-2">
        <Link href="/methodology#runs" className="text-ink underline underline-offset-4 decoration-line-2 hover:decoration-ink">Where these ran, and how to add your own run</Link>.
      </p>
    </div>
  );
}
