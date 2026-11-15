"use client";

import Link from "next/link";
import { useState } from "react";
import { site } from "@/lib/site";

/** Enough digits to tell sub-cent runs apart. */
const money = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : n >= 0.001 ? `$${n.toFixed(4)}` : `$${n.toFixed(6)}`);
/** A fixed charge: "$0.01". */
const fee = (n: number) => `$${Number(n.toPrecision(2))}`;
const perHour = (n: number) => `$${n >= 1 ? n.toFixed(2) : Number(n.toPrecision(3))}/h`;
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
const runLength = (s: number) => (s < 60 ? plural(s, "second") : s < 3600 ? plural(Math.round(s / 60), "minute") : plural(Math.round(s / 3600), "hour"));

/** One table, like the providers table: pick the job above it, providers ranked by what that run costs. */
export function UseCaseTable() {
  const [id, setId] = useState(site.useCases[0]?.id);
  const u = site.useCases.find((x) => x.id === id) ?? site.useCases[0];
  if (!u) return null;
  const max = Math.max(...u.top.map((r) => r.runUsd), 1e-9);
  const chip = (on: boolean) => `rounded-full px-2.5 py-1 text-[12px] ${on ? "bg-accent text-bg" : "text-ink-2 hover:bg-accent-soft hover:text-ink"}`;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-y border-line py-3 text-[12px]">
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-2 text-muted">Job</span>
          {site.useCases.map((x) => (
            <button key={x.id} aria-pressed={x.id === u.id} onClick={() => setId(x.id)} className={chip(x.id === u.id)}>
              {x.title}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-4 text-[14px] text-ink-2">
        {u.blurb}{" "}
        <span className="font-mono text-[12px] text-muted">
          {u.spec.vcpu} vCPU / {u.spec.memoryGb} GB · {runLength(u.runSeconds)}
          {u.require.length ? ` · needs ${u.require.join(", ")}` : ""}
        </span>
      </p>
      <table className="mt-4 w-full text-[14px]">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-[0.12em] text-muted">
            <th className="w-10 py-3 pr-2 font-normal">#</th>
            <th className="py-3 pr-4 font-normal">Provider</th>
            <th className="py-3 pr-4 font-normal">This run</th>
            <th className="hidden py-3 font-normal sm:table-cell">Per hour, this run</th>
          </tr>
        </thead>
        <tbody>
          {u.top.map((r, i) => {
            const why = [
              r.minimumSeconds > u.runSeconds ? `bills at least ${r.minimumSeconds} s` : "",
              r.perSandboxUsd ? `+${fee(r.perSandboxUsd)} per sandbox` : "",
            ].filter(Boolean);
            return (
              <tr key={r.provider} className="group border-t border-line">
                <td className="py-3 pr-2 font-mono text-[12px] text-muted">{i + 1}</td>
                <td className="py-3 pr-4">
                  <Link href={`/providers/${r.provider}`} className="text-ink group-hover:underline underline-offset-4 decoration-line-2">
                    {r.name}
                  </Link>
                  {why.length ? <span className="ml-2 text-[11px] text-muted">{why.join(", ")}</span> : null}
                </td>
                <td className="py-3 pr-4">
                  <div className="flex items-center gap-3" title={`${r.name}: ${money(r.runUsd)} for ${runLength(u.runSeconds)}`}>
                    <span className="w-24 font-mono tnum text-ink">{money(r.runUsd)}</span>
                    <span className="hidden h-px w-28 bg-line sm:block">
                      <span className="block h-px bg-bar" style={{ width: `${(r.runUsd / max) * 100}%` }} />
                    </span>
                  </div>
                </td>
                <td className="hidden py-3 font-mono tnum text-ink-2 sm:table-cell">{perHour(r.runHourlyUsd)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
