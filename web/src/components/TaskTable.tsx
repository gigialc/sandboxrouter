"use client";

import Link from "next/link";
import { useState } from "react";
import published from "@/data/published.json";
import { recommend, type PublishedData, type RecJob } from "@/lib/recommend";
import { site } from "@/lib/site";

/** Enough digits to tell cheap tasks apart. */
const money = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(4)}`);
const secs = (ms: number) => (ms >= 120_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 1000).toFixed(1)} s`);
const perHour = (n: number) => `$${n >= 1 ? n.toFixed(2) : n >= 0.01 ? n.toFixed(3) : n.toFixed(4)}/h`;

/** Measured cost of the standard task (src/task.ts) on each provider, cheapest first: the short job or the long one. Same look as the providers table. */
export function TaskTable() {
  const { kinds } = site.tasks;
  const [id, setId] = useState(kinds[0]?.id);
  // "fresh": a new sandbox for every job (start, minimum and per-sandbox fee each time). "reused": every job in
  // one sandbox that's already running, so those are paid once and drop out.
  const [mode, setMode] = useState<"fresh" | "reused">("fresh");
  // "cheapest" by cost, "fastest" by time, or "value": cost and time together, each against the median, so a
  // provider ranks high only if it's both cheap and quick (score 1 = median on both; lower is better).
  const [sort, setSort] = useState<"cheapest" | "value" | "fastest">("cheapest");
  const k = kinds.find((x) => x.id === id) ?? kinds[0];
  if (!k) return null;
  // The order comes from the same recommend() the SDK, CLI and MCP tool use: per successful run, start included
  // when each job starts its own sandbox.
  const ranked = recommend(published as PublishedData, {
    job: k.id as RecJob,
    reuse: mode !== "fresh",
    priority: sort === "cheapest" ? "cost" : sort === "fastest" ? "speed" : "value",
  }).results;
  const order = new Map(ranked.map((x) => [x.provider, x]));
  const cost = (r: (typeof k.rows)[number]) => (mode === "fresh" ? r.taskUsd : r.reusedUsd);
  const value = (r: (typeof k.rows)[number]) => order.get(r.provider)?.valueScore ?? Infinity;
  const rows = [...k.rows].sort((a, b) => (order.get(a.provider)?.rank ?? Infinity) - (order.get(b.provider)?.rank ?? Infinity));
  const maxTask = Math.max(...k.rows.map((r) => r.taskMs), 1);
  // A row with far fewer runs than the rest says so: its median rests on less.
  const mostRuns = Math.max(...k.rows.map((r) => r.runs), 1);
  const chip = (on: boolean) => `rounded-full px-2.5 py-1 text-[12px] ${on ? "bg-accent text-bg" : "text-ink-2 hover:bg-accent-soft hover:text-ink"}`;

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-y border-line py-3 text-[12px]">
        {kinds.length > 1 && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-2 text-muted">Job</span>
            {kinds.map((x) => (
              <button key={x.id} aria-pressed={x.id === k.id} onClick={() => setId(x.id)} className={chip(x.id === k.id)}>
                {x.title}
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-2 text-muted">Sandbox</span>
          {(
            [
              ["fresh", "New for each job"],
              ["reused", "One for all jobs"],
            ] as const
          ).map(([m, label]) => (
            <button key={m} aria-pressed={mode === m} onClick={() => setMode(m)} className={chip(mode === m)}>
              {label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-2 text-muted">Rank by</span>
          {(
            [
              ["cheapest", "Cheapest"],
              ["value", "Best value"],
              ["fastest", "Fastest"],
            ] as const
          ).map(([m, label]) => (
            <button key={m} aria-pressed={sort === m} onClick={() => setSort(m)} className={chip(sort === m)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-4 text-[14px] text-ink-2">
        {k.blurb}{" "}
        <span className="text-muted">
          {mode === "fresh"
            ? "Each job starts its own sandbox: its start, minimum charge and per-sandbox fee count every time."
            : "Every job runs in one sandbox that's already up: only the job's own time counts."}
          {" Ranked per successful run: a provider whose runs sometimes failed has its cost and time divided by its success rate."}
          {sort === "value" ? " Best value: cost times time, each against the median; 1.0 is the median on both, lower is better." : ""}
        </span>
      </p>
      <table className="mt-4 w-full text-[14px]">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-[0.12em] text-muted">
            <th className="w-10 py-3 pr-2 font-normal">#</th>
            <th className="py-3 pr-4 font-normal">Provider</th>
            <th className="py-3 pr-4 font-normal">Task took</th>
            <th className="py-3 pr-4 font-normal">1,000 tasks cost</th>
            <th className="hidden py-3 font-normal sm:table-cell">{sort === "value" ? "Value score" : "Per hour"}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const notes = [
              r.size.vcpu !== 2 || r.size.memoryGb !== 4 ? `${r.size.vcpu} vCPU / ${r.size.memoryGb} GB` : "",
              mode === "fresh" && r.minimumSeconds > 1 ? `bills at least ${r.minimumSeconds} s` : "",
              mode === "fresh" && r.perSandboxUsd ? `+$${Number(r.perSandboxUsd.toPrecision(2))} per sandbox` : "",
              r.activeCpu ? (r.cpuMs !== undefined ? "billed for CPU used" : "priced at full CPU") : "",
              r.runs < mostRuns / 2 ? `only ${r.runs} runs` : "",
            ].filter(Boolean);
            const split =
              k.phases.map((p) => `${p.label} ${secs(r.phasesMs[p.id])}`).join(", ") +
              (r.cpuMs !== undefined ? `; used ${secs(r.cpuMs)} of CPU across all cores` : "");
            return (
              <tr key={r.provider} className="group border-t border-line">
                <td className="py-3 pr-2 font-mono text-[12px] text-muted">{i + 1}</td>
                <td className="py-3 pr-4">
                  <Link href={`/providers/${r.provider}`} className="text-ink group-hover:underline underline-offset-4 decoration-line-2">
                    {r.name}
                  </Link>
                  {notes.length ? <span className="ml-2 text-[11px] text-muted">{notes.join(", ")}</span> : null}
                </td>
                <td className="py-3 pr-4">
                  <div className="flex items-center gap-3" title={`${split}; started in ${secs(r.createMs)}`}>
                    <span className="w-16 font-mono tnum text-ink">{secs(r.taskMs)}</span>
                    <span className="hidden h-px w-28 bg-line sm:block">
                      <span className="block h-px bg-bar" style={{ width: `${(r.taskMs / maxTask) * 100}%` }} />
                    </span>
                  </div>
                </td>
                <td className="py-3 pr-4 font-mono tnum text-ink">{money(cost(r) * 1000)}</td>
                <td className="hidden py-3 font-mono tnum text-ink-2 sm:table-cell">{sort === "value" ? value(r).toFixed(2) : perHour(r.hourlyUsd)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {k.couldNot.length > 0 && (
        <p className="mt-3 text-[12px] text-muted">Couldn&apos;t run this job in its default setup: {k.couldNot.join(", ")}.</p>
      )}
    </div>
  );
}
