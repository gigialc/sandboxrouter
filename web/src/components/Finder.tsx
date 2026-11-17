"use client";

import { useState } from "react";
import published from "@/data/published.json";
import { recommend, type PublishedData, type RecJob, type RecPriority } from "@/lib/recommend";
import { ProviderName } from "@/components/ProviderName";

const JOBS: [RecJob, string][] = [
  ["agent", "Agent session"],
  ["python", "Code run / RL step"],
  ["repo", "Coding agent on a repo"],
  ["short", "Short CPU job"],
  ["long", "Long job"],
  ["download", "Download"],
  ["start", "Just start one"],
];
const COUNTS = [1, 10, 100];
const PRIORITIES: [RecPriority, string][] = [
  ["value", "Best value"],
  ["cost", "Cheapest"],
  ["speed", "Fastest"],
];

const secs = (s: number) => (s >= 10 ? `${s.toFixed(0)} s` : `${s.toFixed(1)} s`);
const money = (n?: number) => (n === undefined ? "n/a" : n >= 1 ? `$${n.toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(4)}`);
const chip = (on: boolean) =>
  `px-3 py-1.5 text-[13px] border ${on ? "border-accent bg-accent text-bg" : "border-line text-ink-2 hover:border-line-2 hover:text-ink"}`;

/**
 * The short answer: pick what you're running, how many at once and what matters, and get the providers ranked
 * from the measured results, with the same recommend() the SDK, CLI and MCP tool use.
 */
export function Finder() {
  const [job, setJob] = useState<RecJob>("agent");
  const [count, setCount] = useState(1);
  const [priority, setPriority] = useState<RecPriority>("value");
  const r = recommend(published as PublishedData, { job, count, priority, limit: 6 });

  const row = (label: string, children: React.ReactNode) => (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <span className="w-36 shrink-0 text-[12px] uppercase tracking-[0.12em] text-muted">{label}</span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );

  return (
    <section id="find" className="mt-10 scroll-mt-32 border border-line p-5 sm:p-7">
      <h2 className="text-xl font-normal tracking-[-0.02em] sm:text-2xl">Find the best provider for your job</h2>
      <div className="mt-5 space-y-3">
        {row(
          "Running",
          JOBS.map(([id, label]) => (
            <button key={id} aria-pressed={job === id} onClick={() => setJob(id)} className={chip(job === id)}>
              {label}
            </button>
          )),
        )}
        {row(
          "At once",
          COUNTS.map((n) => (
            <button key={n} aria-pressed={count === n} onClick={() => setCount(n)} className={chip(count === n)}>
              {n === 1 ? "One" : n}
            </button>
          )),
        )}
        {row(
          "Most important",
          PRIORITIES.map(([id, label]) => (
            <button key={id} aria-pressed={priority === id} onClick={() => setPriority(id)} className={chip(priority === id)}>
              {label}
            </button>
          )),
        )}
      </div>

      <table className="mt-6 w-full text-[14px]">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-[0.12em] text-muted">
            <th className="w-8 py-2 pr-2 font-normal">#</th>
            <th className="py-2 pr-4 font-normal">Provider</th>
            <th className="py-2 pr-4 font-normal">{job === "start" ? "Ready in" : "Time each"}</th>
            <th className="py-2 pr-4 font-normal">{job === "start" ? "Per hour" : count > 1 ? `Cost for ${count}` : "Cost each"}</th>
            <th className="hidden py-2 font-normal md:table-cell">Worth knowing</th>
          </tr>
        </thead>
        <tbody>
          {r.results.map((x) => (
            <tr key={x.provider} className={`group border-t border-line ${x.rank === 1 ? "bg-accent-soft" : ""}`}>
              <td className="py-3 pr-2 font-mono text-[12px] text-muted">{x.rank}</td>
              <td className="py-3 pr-4">
                <ProviderName id={x.provider} name={x.name}>
                  {x.rank === 1 ? <span className="text-[11px] text-accent">best pick</span> : null}
                </ProviderName>
              </td>
              <td className="py-3 pr-4 font-mono tnum text-ink">{secs(x.secondsEach)}</td>
              <td className="py-3 pr-4 font-mono tnum text-ink">{job === "start" ? `${money(x.hourlyUsd)}/h` : money(count > 1 ? x.usdTotal : x.usdEach)}</td>
              <td className="hidden py-3 text-[12px] text-muted md:table-cell">{x.notes.join(" · ") || ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-4 text-[12px] leading-5 text-muted">
        {r.basis} Same answer in code:{" "}
        <code className="font-mono text-[12px] text-ink-2">
          npx @sandboxrouter/sdk recommend --job {job}
          {count > 1 ? ` --count ${count}` : ""}
          {priority !== "value" ? ` --priority ${priority}` : ""}
        </code>
      </p>
    </section>
  );
}
