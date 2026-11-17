import type { Metadata } from "next";
import { PageHeader } from "@/components/chrome";
import Link from "next/link";
import { AgentTable } from "@/components/AgentTable";
import { BenchTabs } from "@/components/BenchTabs";
import { Finder } from "@/components/Finder";
import { LoadTable } from "@/components/LoadTable";
import { TaskTable } from "@/components/TaskTable";
import { UseCaseTable } from "@/components/UseCaseTable";
import { BarNum, Num, ResultRow, ResultTable, barMax, perHour, time } from "@/components/results";
import { site } from "@/lib/site";

export const metadata: Metadata = { title: "Benchmarks" };

const cents = (n: number | null) => (n === null ? "n/a" : n === 0 ? "$0" : `$${n < 0.01 ? n.toFixed(4) : n.toFixed(3)}`);
const shortDay = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
/** One section: its title, one line, a link to how it's measured, then its table. */
function Section({ id, title, how, children, line }: { id: string; title: string; how: string; line: React.ReactNode; children: React.ReactNode }) {
  return (
    <section aria-label={title} data-section={id} className="mt-8">
      <p className="max-w-3xl text-[15px] leading-6 text-ink">
        {line}{" "}
        <Link href={`/methodology#${how}`} className="text-[13px] text-muted underline underline-offset-4 decoration-line-2 hover:text-ink">
          How it&apos;s measured
        </Link>
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
  const maxCreate = barMax(rows.map((r) => r.medianCreateMs ?? 0));
  const costs = site.costRuns.filter((r) => !r.error && r.billedUsd !== null && r.billedUsd > 0);
  // A fixed charge per sandbox isn't running time: shown apart, and taken out of the ratio the router uses.
  const feeOf = (id: string) => site.providers.find((p) => p.id === id)?.pricing.perSandboxUsd ?? 0;
  const vsList = (r: (typeof costs)[number]) =>
    r.predictedUsd ? `${Math.round((((r.billedUsd ?? 0) - feeOf(r.provider)) / r.predictedUsd) * 100)}%` : "n/a";

  return (
    <div className="px-5 sm:px-10 pt-14">
      <PageHeader kicker="Benchmarks" title="What each sandbox costs, and how it performs">
        Real sandboxes on real accounts, started, used and killed: {totalRuns.toLocaleString("en-US")} so far.
        <span className="mt-3 block text-[13px] text-muted">
          For agents:{" "}
          <a href="/benchmarks.json" className="underline underline-offset-4 decoration-line-2 hover:text-ink">JSON</a> ·{" "}
          <a href="/benchmarks.md" className="underline underline-offset-4 decoration-line-2 hover:text-ink">Markdown</a> ·{" "}
          <a href="/llms.txt" className="underline underline-offset-4 decoration-line-2 hover:text-ink">llms.txt</a> · MCP at{" "}
          <code className="font-mono text-[12px]">sandboxrouter.ai/mcp</code>
        </span>
      </PageHeader>

      <Finder />

      <BenchTabs
        tabs={[
          {
            id: "cost",
            label: "Prices",
            content: (
      <Section id="cost" title="Cost for the job" how="pricing" line="The cheapest provider depends on how long you use it: tested providers, ranked by what each job would be billed.">
        <div className="mt-6">
          <UseCaseTable />
        </div>
      </Section>
            ),
          },

          ...(site.tasks.kinds.length > 0
            ? [
                {
                  id: "task",
                  label: "Real jobs",
                  content: (
        <Section id="task" title="Real work" how="jobs" line="The same job on every provider, from a short burst of CPU to installing a real repo, priced by how long it really took.">
          <TaskTable />
        </Section>
                  ),
                },
              ]
            : []),

          ...(site.agent.length > 0
            ? [
                {
                  id: "agent",
                  label: "Real AI agent",
                  content: (
        <Section id="agent" title="A real agent" how="agent" line="A real model does the same task in a sandbox on each provider, with one tool that runs commands there.">
          <AgentTable />
        </Section>
                  ),
                },
              ]
            : []),

          ...(site.load.length > 0
            ? [
                {
                  id: "load",
                  label: "At scale",
                  content: (
        <Section id="load" title="Under load" how="load" line="10 or 100 sandboxes asked for at once: how fast they're ready, and what all of them cost.">
          <LoadTable />
        </Section>
                  ),
                },
              ]
            : []),

          {
            id: "speed",
            label: "Start time",
            content: (
      <Section
        id="speed"
        title="Start time"
        how="speed"
        line={`${rows.length} providers${subs[0] ? `, last run ${day(subs[0].date)}` : ""}: time to a usable sandbox, one at a time, 100 runs each where our account allowed.`}
      >

      <ResultTable
        cols={[
          { label: "Median start" },
          { label: "Command", className: "hidden sm:table-cell" },
          { label: "Worked", className: "hidden md:table-cell" },
          { label: "Per hour" },
        ]}
      >
        {rows.map((r, i) => (
          <ResultRow
            key={r.provider}
            rank={i + 1}
            id={r.provider}
            name={r.name}
            notes={[
              r.size.vcpu !== 2 || r.size.memoryGb !== 4 ? `${r.size.vcpu} vCPU / ${r.size.memoryGb} GB` : "",
              r.runs < 20 ? `only ${r.runs} runs` : "",
            ].filter(Boolean)}
          >
            <BarNum value={r.medianCreateMs ?? 0} max={maxCreate} title={`${r.name}: median start ${time(r.medianCreateMs)} over ${r.runs} runs, measured ${shortDay(r.measuredAt)}`}>
              {time(r.medianCreateMs)}
            </BarNum>
            <Num className="hidden sm:table-cell" title="Median round trip of one command, once started">
              {time(r.medianExecMs)}
            </Num>
            <Num className="hidden md:table-cell">{Math.round(r.successRate * 100)}%</Num>
            <Num>{perHour(r.hourlyUsd)}</Num>
          </ResultRow>
        ))}
      </ResultTable>
      </Section>
            ),
          },

          ...(costs.length > 0
            ? [
                {
                  id: "real-cost",
                  label: "Real bills",
                  content: (
        <Section id="real-cost" title="Bills" how="bills" line="What providers actually billed for a sandbox run for a fixed time, read from their own billing APIs.">
          <ResultTable
            ranked={false}
            cols={[
              { label: "Ran", className: "hidden sm:table-cell" },
              { label: "List price said" },
              { label: "Billed" },
              { label: "Running time vs list", className: "hidden md:table-cell" },
            ]}
          >
            {costs.map((r) => (
              <ResultRow
                key={`${r.date}-${r.provider}`}
                id={r.provider}
                name={r.name}
                notes={[shortDay(r.date), feeOf(r.provider) ? `billed includes a ${cents(feeOf(r.provider))} start fee` : ""].filter(Boolean)}
              >
                <Num className="hidden sm:table-cell">{r.seconds === null ? "n/a" : `${Math.round(r.seconds / 60)} min`}</Num>
                <Num>{cents(r.predictedUsd)}</Num>
                <Num strong>{cents(r.billedUsd)}</Num>
                <Num className="hidden md:table-cell">{vsList(r)}</Num>
              </ResultRow>
            ))}
          </ResultTable>
        </Section>
                  ),
                },
              ]
            : []),
        ]}
      />

      <p className="mt-16 border-t border-line pt-8 text-[14px] text-ink-2">
        <Link href="/methodology#runs" className="text-ink underline underline-offset-4 decoration-line-2 hover:decoration-ink">Where these ran, and how to add your own run</Link>.
      </p>
    </div>
  );
}
