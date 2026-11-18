"use client";

import { ConditionalStartFeeNote } from "@/components/ConditionalStartFeeNote";
import { useState } from "react";
import published from "@/data/published.json";
import { BarNum, Footnote, Num, ResultRow, ResultTable, Segmented, Toolbar, barMax, money, perHour, time } from "@/components/results";
import { recommend, type PublishedData, type RecJob } from "@/lib/recommend";
import { OWN_IMAGE_NOTE, needsOwnImage, site, sizeNote } from "@/lib/site";

type Sort = "cheapest" | "value" | "fastest";
type Mode = "fresh" | "reused";

/**
 * The same job measured on every provider, priced by each one's billing rules. Ranked with the same recommend()
 * the SDK, CLI and MCP tool use: per successful run, start included when each job starts its own sandbox.
 */
export function TaskTable() {
  const { kinds } = site.tasks;
  const [id, setId] = useState(kinds[0]?.id);
  const [mode, setMode] = useState<Mode>("fresh");
  const [sort, setSort] = useState<Sort>("cheapest");
  const k = kinds.find((x) => x.id === id) ?? kinds[0];
  if (!k) return null;
  const ranked = recommend(published as PublishedData, {
    job: k.id as RecJob,
    reuse: mode !== "fresh",
    priority: sort === "cheapest" ? "cost" : sort === "fastest" ? "speed" : "value",
  }).results;
  const order = new Map(ranked.map((x) => [x.provider, x]));
  // Per successful run, the same division the ranking, the finder and the homepage use.
  const cost = (r: (typeof k.rows)[number]) => (mode === "fresh" ? r.taskUsd : r.reusedUsd) / Math.max(r.successRate, 0.01);
  // Fastest ranks a new sandbox by start plus job, so that is the time shown; otherwise the job alone.
  const withStart = sort === "fastest" && mode === "fresh";
  const took = (r: (typeof k.rows)[number]) => (withStart ? r.createMs + r.taskMs : r.taskMs);
  // The hourly column is priced at the job's CPU share when it is mostly idle, so it is not the list rate.
  const idleCpu = k.cpuUtilization !== null && k.cpuUtilization < 1 ? k.cpuUtilization : undefined;
  const rows = [...k.rows].sort((a, b) => (order.get(a.provider)?.rank ?? Infinity) - (order.get(b.provider)?.rank ?? Infinity));
  const mostRuns = Math.max(...k.rows.map((r) => r.runs), 1);
  const requested = k.outcomes.reduce((total, row) => total + row.requested, 0);
  const completed = k.outcomes.reduce((total, row) => total + row.completed, 0);
  const maxCost = barMax(rows.map(cost));
  const maxTime = barMax(rows.map(took));

  const costCol = (r: (typeof rows)[number]) =>
    sort === "fastest" ? (
      <Num>{money(cost(r) * 1000)}</Num>
    ) : (
      <BarNum value={cost(r)} max={maxCost}>
        {money(cost(r) * 1000)}
      </BarNum>
    );
  const timeCol = (r: (typeof rows)[number]) => {
    const split = k.phases.map((p) => `${p.label} ${time(r.phasesMs[p.id])}`).join(", ") + `; started in ${time(r.createMs)}`;
    return sort === "fastest" ? (
      <BarNum value={took(r)} max={maxTime} title={split}>
        {time(took(r))}
      </BarNum>
    ) : (
      <Num title={split}>{time(took(r))}</Num>
    );
  };

  return (
    <div>
      <Toolbar
        note={
          <>
            {k.blurb}{" "}
            {completed} of {requested} workloads passed output verification across {k.outcomes.length} tested {k.outcomes.length === 1 ? "provider" : "providers"}.{" "}
            {mode === "fresh"
              ? "Each job starts its own sandbox, so its start and minimum charge count every time. Start fees that depend on your plan are left out and noted below."
              : "Every job runs in one sandbox that's already up, so only the job's own time counts."}
          </>
        }
      >
        <Segmented label="Job" options={kinds.map((x) => [x.id, x.title] as const)} value={k.id} onChange={setId} />
        <Segmented
          label="Sandbox"
          options={[
            ["fresh", "New each job"],
            ["reused", "Reused"],
          ]}
          value={mode}
          onChange={setMode}
        />
        <Segmented
          label="Rank by"
          options={[
            ["cheapest", "Cheapest"],
            ["value", "Best value"],
            ["fastest", "Fastest"],
          ]}
          value={sort}
          onChange={setSort}
        />
      </Toolbar>
      {rows.length > 0 && <ResultTable
        cols={[
          { label: "Est. / 1,000 jobs" },
          { label: withStart ? "Start + job" : "Job took" },
          { label: sort === "value" ? "Value" : idleCpu ? "Effective / hour" : "Per hour", className: "hidden sm:table-cell" },
        ]}
      >
        {rows.map((r, i) => (
          <ResultRow
            key={r.provider}
            rank={i + 1}
            id={r.provider}
            name={r.name}
            notes={[
              sizeNote(r.size),
              needsOwnImage(r.provider, r.size) ? OWN_IMAGE_NOTE : "",
              mode === "fresh" && r.minimumSeconds > 1 ? `bills at least ${r.minimumSeconds} s` : "",
              mode === "fresh" && r.perSandboxUsd ? `+${money(r.perSandboxUsd)} per sandbox` : "",
              r.activeCpu ? (r.cpuMs !== undefined ? "billed for CPU used" : "priced at full CPU") : "",
              `${r.ok}/${r.runs} workloads verified`,
              r.limited ? `${r.limited} reported limit refusals` : "",
              r.runs < mostRuns / 2 ? `only ${r.runs} runs` : "",
            ].filter(Boolean)}
          >
            {costCol(r)}
            {timeCol(r)}
            <Num className="hidden sm:table-cell">{sort === "value" ? (order.get(r.provider)?.valueScore ?? 0).toFixed(2) : perHour(r.hourlyUsd)}</Num>
          </ResultRow>
        ))}
      </ResultTable>}
      {rows.length > 0 && <Footnote>
        Cost is per successful run: rankings divide estimated cost and time by the share of requests that completed. This is a retry estimate.
        {sort !== "value" && idleCpu ? ` Effective / hour prices this job at ${Math.round(idleCpu * 100)}% CPU, so it is not the list rate.` : ""}
        {sort === "value" ? " Value is cost times time, each against the median: 1.0 is the median, lower is better." : ""}
        {mode === "fresh" && <> <ConditionalStartFeeNote ids={rows.map((r) => r.provider)} /></>}
      </Footnote>}
      {k.outcomes.some((r) => r.completed < r.requested) && (
        <ul className="mt-3 list-disc space-y-1 pl-5 text-[13px] text-muted">
          {k.outcomes.filter((r) => r.completed < r.requested).map((r) => (
            <li key={r.provider}>
              {r.name} verified {r.completed}/{r.requested}.
              {r.limited > 0 && ` ${r.limited} reported limit refusals.`}
              {r.failures > 0 && ` ${r.failures} other start or first-command failures.`}
              {r.taskFailures > 0 && ` ${r.taskFailures} workload failures.`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
