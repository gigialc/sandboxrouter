import type { Metadata } from "next";
import { pageAlternates } from "@/lib/public-pages";
import { PageHeader } from "@/components/chrome";
import Link from "next/link";
import { AgentTable } from "@/components/AgentTable";
import { BenchTabs } from "@/components/BenchTabs";
import { BillTable } from "@/components/BillTable";
import { Finder } from "@/components/Finder";
import { ImageTable } from "@/components/ImageTable";
import { SteadyTable } from "@/components/SteadyTable";
import { AssistantTable } from "@/components/AssistantTable";
import { LoadTable } from "@/components/LoadTable";
import { TaskTable } from "@/components/TaskTable";
import { UseCaseTable } from "@/components/UseCaseTable";
import { ConditionalStartFeeNote, hasStartFee } from "@/components/ConditionalStartFeeNote";
import { BarNum, Footnote, Num, ResultRow, ResultTable, barMax, perHour, time } from "@/components/results";
import { REPO, site } from "@/lib/site";

const description = "Compare sandbox startup and job times, estimated costs, and bills from real provider accounts.";
export const metadata: Metadata = {
  alternates: pageAlternates("/benchmarks"),
  title: "Benchmarks",
  description,
  openGraph: { title: "SandboxRouter Benchmarks", description, url: "/benchmarks" },
  twitter: { card: "summary_large_image", title: "SandboxRouter Benchmarks", description },
};

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
  const timedStarts = rows.filter((r) => r.medianCreateMs !== undefined);
  const latestStart = timedStarts.map((r) => r.measuredAt).sort().at(-1);
  const maxCreate = barMax(rows.map((r) => r.medianCreateMs ?? 0));
  // Delete timing started later than create timing: the column appears once a report has it.
  const timedDeletes = rows.some((r) => r.medianKillMs !== undefined);

  return (
    <div className="px-5 sm:px-10 pt-14">
      <PageHeader kicker="Benchmarks" title="What each sandbox costs, and how it performs">
        Results from real provider accounts. Prices are estimates unless marked as provider billing data.
        <span className="mt-3 block text-[13px] text-muted">
          Older workload reports are in the{" "}
          <a href={`${REPO}/tree/e1a17220f875b6911a85bb8d8c9913ddeff1bf29/results`} className="underline underline-offset-4">
            benchmark archive
          </a>. The current workload rankings use runs with output verification.
        </span>
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
      <Section id="cost" title="Cost for the job" how="pricing" line="The cheapest provider depends on how long you use it: tested providers, ranked by estimated cost before account-specific fees.">
        <div className="mt-6">
          <UseCaseTable />
        </div>
      </Section>
            ),
          },

                {
                  id: "task",
                  label: "Real jobs",
                  content: (
        <Section id="task" title="Real work" how="jobs" line="Workloads with verified output. Cost estimates use measured runtimes and provider pricing.">
          {site.tasks.kinds.length > 0 ? <TaskTable /> :
            <p className="mt-4 text-[13px] text-muted">No results have been published with the new workload checks yet.</p>}
        </Section>
                  ),
                },

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
        <Section id="load" title="Under load" how="load" line="Batches of 10 or 100 requests, with readiness times, outcomes and estimated costs for complete batches.">
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
        line={`${timedStarts.length} providers with a create timing${latestStart ? `, latest included timing ${day(latestStart)}` : ""}. Create response and command round trip are measured separately.`}
      >

      <ResultTable
        cols={[
          { label: "Median create" },
          { label: "Command", className: "hidden sm:table-cell" },
          ...(timedDeletes ? [{ label: "Delete", className: "hidden sm:table-cell" }] : []),
          { label: "Ready, excluding limit refusals", className: "hidden md:table-cell" },
          { label: "Per hour" },
        ]}
      >
        {rows.map((r, i) => (
          <ResultRow
            key={r.provider}
            rank={r.medianCreateMs === undefined ? 0 : i + 1}
            id={r.provider}
            name={r.name}
            notes={[
              r.size.vcpu !== 2 || r.size.memoryGb !== 4 ? `${r.size.vcpu} vCPU / ${r.size.memoryGb} GB` : "",
              r.runs === 0 ? "All requests refused by the test account limit" : `${r.runs} requests excluding limit refusals`,
              r.killWaitsUntilGone ? "Delete time includes waiting until the sandbox is gone" : "",
            ].filter(Boolean)}
          >
            {r.medianCreateMs === undefined ? <Num>—</Num> : (
              <BarNum value={r.medianCreateMs} max={maxCreate} title={`${r.name}: median create response ${time(r.medianCreateMs)} across ${r.runs} requests excluding limit refusals, measured ${shortDay(r.measuredAt)}`}>
                {time(r.medianCreateMs)}
              </BarNum>
            )}
            <Num className="hidden sm:table-cell" title="Median round trip of one command, once started">
              {time(r.medianExecMs)}
            </Num>
            {timedDeletes && (
              <Num className="hidden sm:table-cell" title="Median time for the delete call to return">
                {r.medianKillMs === undefined ? "—" : time(r.medianKillMs)}
              </Num>
            )}
            <Num className="hidden md:table-cell">{r.runs > 0 ? `${Math.round(r.successRate * 100)}%` : "—"}</Num>
            <Num>{perHour(r.hourlyUsd)}</Num>
          </ResultRow>
        ))}
      </ResultTable>
      {timedDeletes && (
        <Footnote>
          Delete is the time the delete call takes to return. Where a row says so, the router waits until the sandbox is gone, because that
          provider&apos;s delete request only schedules the deletion; the other rows time the request alone.
        </Footnote>
      )}
      {hasStartFee(rows.map((r) => r.provider)) && (
        <Footnote>
          Per hour is the list price at the size shown. <ConditionalStartFeeNote ids={rows.map((r) => r.provider)} what="hourly prices" />
        </Footnote>
      )}
      </Section>
            ),
          },

          ...(site.image.length > 0
            ? [
                {
                  id: "image",
                  label: "Straight from an image",
                  content: (
        <Section id="image" title="Straight from an image" how="image" line="Start a sandbox straight from a public registry image, with no template or snapshot to build first.">
          <ImageTable />
        </Section>
                  ),
                },
              ]
            : []),

          ...(site.steady.length > 0
            ? [
                {
                  id: "steady",
                  label: "Over time",
                  content: (
        <Section id="steady" title="Speed over time" how="steady" line="One sandbox kept running, doing the same small job every few seconds: does it stay as fast as it started.">
          <SteadyTable />
        </Section>
                  ),
                },
              ]
            : []),

          ...(site.assistant.length > 0
            ? [
                {
                  id: "assistant",
                  label: "Assistant",
                  content: (
        <Section id="assistant" title="An assistant session" how="assistant" line="One conversation of a chat assistant with a code tool: the first answer, a file in, a file out, many short calls, and a call after a quiet minute.">
          <AssistantTable />
        </Section>
                  ),
                },
              ]
            : []),

          {
            id: "real-cost",
            label: "Real bills",
            content: (
              <Section id="real-cost" title="Bills" how="bills" line="Compare the list estimate with metered sandbox usage and recorded hosted charges.">
                <BillTable />
              </Section>
            ),
          },
        ]}
      />

      <p className="mt-16 border-t border-line pt-8 text-[14px] text-ink-2">
        <Link href="/methodology#runs" className="text-ink underline underline-offset-4 decoration-line-2 hover:decoration-ink">Where these ran, and how to add your own run</Link>.
      </p>
    </div>
  );
}
