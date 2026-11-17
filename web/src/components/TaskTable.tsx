"use client";

import { ConditionalStartFeeNote } from "@/components/ConditionalStartFeeNote";
import { useState } from "react";
import published from "@/data/published.json";
import { BarNum, Footnote, Num, ResultRow, ResultTable, Segmented, Toolbar, barMax, money, perHour, time } from "@/components/results";
import { recommend, type PublishedData, type RecJob } from "@/lib/recommend";
import { site } from "@/lib/site";

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
  const cost = (r: (typeof k.rows)[number]) => (mode === "fresh" ? r.taskUsd : r.reusedUsd);
  const rows = [...k.rows].sort((a, b) => (order.get(a.provider)?.rank ?? Infinity) - (order.get(b.provider)?.rank ?? Infinity));
  const mostRuns = Math.max(...k.rows.map((r) => r.runs), 1);
  const maxCost = barMax(rows.map(cost));
  const maxTime = barMax(rows.map((r) => r.taskMs));

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
      <BarNum value={r.taskMs} max={maxTime} title={split}>
        {time(r.taskMs)}
      </BarNum>
    ) : (
      <Num title={split}>{time(r.taskMs)}</Num>
    );
  };

  return (
    <div>
      <Toolbar
        note={
          <>
            {k.blurb}{" "}
            {mode === "fresh"
              ? "Each job starts its own sandbox, so its start, minimum charge and per-sandbox fee count every time."
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
      <ResultTable
        cols={[
          { label: "Est. / 1,000 jobs" },
          { label: "Job took" },
          { label: sort === "value" ? "Value" : "Per hour", className: "hidden sm:table-cell" },
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
              mode === "fresh" && r.minimumSeconds > 1 ? `bills at least ${r.minimumSeconds} s` : "",
              mode === "fresh" && r.perSandboxUsd ? `+${money(r.perSandboxUsd)} per sandbox` : "",
              r.activeCpu ? (r.cpuMs !== undefined ? "billed for CPU used" : "priced at full CPU") : "",
              r.successRate < 1 ? `${Math.round(r.successRate * 100)}% of runs worked` : "",
              r.runs < mostRuns / 2 ? `only ${r.runs} runs` : "",
            ].filter(Boolean)}
          >
            {costCol(r)}
            {timeCol(r)}
            <Num className="hidden sm:table-cell">{sort === "value" ? (order.get(r.provider)?.valueScore ?? 0).toFixed(2) : perHour(r.hourlyUsd)}</Num>
          </ResultRow>
        ))}
      </ResultTable>
      <Footnote>
        Ranked per successful run: a provider whose runs sometimes failed has its cost and time divided by its success rate.
        {sort === "value" ? " Value is cost times time, each against the median: 1.0 is the median, lower is better." : ""}
        {mode === "fresh" && rows.some((r) => r.provider === "boat") && <> <ConditionalStartFeeNote id="boat" /></>}
        {k.couldNot.length ? ` Couldn't run this job in its default setup: ${k.couldNot.join(", ")}.` : ""}
      </Footnote>
    </div>
  );
}
