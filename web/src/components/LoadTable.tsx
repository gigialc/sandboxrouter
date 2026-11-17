"use client";

import { useState } from "react";
import { ConditionalStartFeeNote } from "@/components/ConditionalStartFeeNote";
import { BarNum, Footnote, Num, ResultRow, ResultTable, Segmented, Toolbar, barMax, money, time } from "@/components/results";
import { site, type LoadRow } from "@/lib/site";

/** Estimated cost scaled to 100 successful outcomes. A partial burst does not establish cost at that scale. */
const per100 = (r: LoadRow) => (r.usd === undefined || !r.ok ? undefined : (r.usd / r.ok) * 100);

/**
 * Only complete batches get a latency rank. Preserve partial and zero-result rows with their outcomes.
 */
export function LoadTable() {
  const kinds = site.load;
  const sizes = [...new Set(kinds.map((k) => k.n))].sort((a, b) => a - b);
  const [n, setN] = useState(sizes[0]);
  const jobs = kinds.filter((k) => k.n === n);
  const [job, setJob] = useState(jobs[0]?.job);
  const k = jobs.find((x) => x.job === job) ?? jobs[0];
  if (!k) return null;
  const full = k.rows.filter((r) => r.ok === r.n).sort((a, b) => (a.p50Ms ?? Infinity) - (b.p50Ms ?? Infinity));
  const partial = k.rows.filter((r) => r.ok < r.n).sort((a, b) => a.name.localeCompare(b.name));
  const max = barMax(full.map((r) => r.p50Ms ?? 0));

  return (
    <div>
      <Toolbar note={`${k.blurb} Readiness is measured from the batch request to the first successful command on each sandbox.`}>
        <Segmented label="At once" options={sizes.map((s) => [s, String(s)] as const)} value={n} onChange={setN} />
        <Segmented label="Job" options={jobs.map((x) => [x.job, x.title] as const)} value={k.job} onChange={setJob} />
      </Toolbar>
      <ResultTable
        cols={[
          { label: "Ready, median" },
          { label: "Ready, p99", className: "hidden sm:table-cell" },
          { label: "Last outcome", className: "hidden md:table-cell" },
          { label: "Est. / 100" },
        ]}
      >
        {[...full, ...partial].map((r, i) => (
          <ResultRow key={r.provider} rank={i < full.length ? i + 1 : 0} id={r.provider} name={r.name} notes={[
            `${r.ok}/${r.n} ${k.job === "start" ? "ready" : "completed"}`,
            r.limited ? `${r.limited} reported limit refusals` : "",
            r.createFailures === undefined && r.n - r.ok > r.limited ? `${r.n - r.ok - r.limited} other failures` : "",
            r.createFailures && r.createFailures > r.limited ? `${r.createFailures - r.limited} other create failures` : "",
            r.commandFailures ? `${r.commandFailures} first-command failures` : "",
            r.taskFailures ? `${r.taskFailures} failed workloads` : "",
            r.cleanupFailures ? `${r.cleanupFailures} cleanup failures` : "",
          ].filter(Boolean)}>
            {r.ok === r.n ? <BarNum value={r.p50Ms ?? 0} max={max}>{time(r.p50Ms)}</BarNum> : <Num>–</Num>}
            <Num className="hidden sm:table-cell">{r.ok === r.n ? time(r.p99Ms) : "–"}</Num>
            <Num className="hidden md:table-cell">{time(r.wallMs)}</Num>
            <Num>{r.ok === r.n ? money(per100(r)) : "–"}</Num>
          </ResultRow>
        ))}
      </ResultTable>
      <Footnote>
        Readiness ranks and scaled cost require a complete batch. Limit refusals are reported by the benchmark; other failures can have several causes.
        {k.n === 10 && " At ten requests, p99 is the slowest observation."}
        {full.some((r) => r.provider === "boat") && <> <ConditionalStartFeeNote id="boat" /></>}
      </Footnote>
    </div>
  );
}
