"use client";

import Link from "next/link";
import { useState } from "react";
import { site } from "@/lib/site";

/** Enough digits to tell cheap tasks apart. */
const money = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(4)}`);
const secs = (ms: number) => (ms >= 120_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 1000).toFixed(1)} s`);
const perHour = (n: number) => `$${n >= 1 ? n.toFixed(2) : n >= 0.01 ? n.toFixed(3) : n.toFixed(4)}/h`;

/** Measured cost of the standard task (src/task.ts) on each provider, cheapest first: the short job or the long one. Same look as the providers table. */
export function TaskTable() {
  const { kinds } = site.tasks;
  const [id, setId] = useState(kinds[0]?.id);
  const k = kinds.find((x) => x.id === id) ?? kinds[0];
  if (!k) return null;
  const maxTask = Math.max(...k.rows.map((r) => r.taskMs), 1);
  const chip = (on: boolean) => `rounded-full px-2.5 py-1 text-[12px] ${on ? "bg-accent text-bg" : "text-ink-2 hover:bg-accent-soft hover:text-ink"}`;

  return (
    <div className="mt-6">
      {kinds.length > 1 && (
        <div className="flex flex-wrap items-center gap-1 border-y border-line py-3 text-[12px]">
          <span className="mr-2 text-muted">Job</span>
          {kinds.map((x) => (
            <button key={x.id} aria-pressed={x.id === k.id} onClick={() => setId(x.id)} className={chip(x.id === k.id)}>
              {x.title}
            </button>
          ))}
        </div>
      )}
      <p className="mt-4 text-[14px] text-ink-2">{k.blurb}</p>
      <table className="mt-4 w-full text-[14px]">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-[0.12em] text-muted">
            <th className="w-10 py-3 pr-2 font-normal">#</th>
            <th className="py-3 pr-4 font-normal">Provider</th>
            <th className="py-3 pr-4 font-normal">Task took</th>
            <th className="py-3 pr-4 font-normal">1,000 tasks cost</th>
            <th className="hidden py-3 font-normal sm:table-cell">Per hour</th>
          </tr>
        </thead>
        <tbody>
          {k.rows.map((r, i) => {
            const notes = [
              r.size.vcpu !== 2 || r.size.memoryGb !== 4 ? `${r.size.vcpu} vCPU / ${r.size.memoryGb} GB` : "",
              r.minimumSeconds > 1 ? `bills at least ${r.minimumSeconds} s` : "",
              r.perSandboxUsd ? `+$${Number(r.perSandboxUsd.toPrecision(2))} per sandbox` : "",
              r.activeCpu ? (r.cpuMs !== undefined ? "billed for CPU used" : "priced at full CPU") : "",
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
                <td className="py-3 pr-4 font-mono tnum text-ink">{money(r.taskUsd * 1000)}</td>
                <td className="hidden py-3 font-mono tnum text-ink-2 sm:table-cell">{perHour(r.hourlyUsd)}</td>
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
