"use client";

import Link from "next/link";
import { useState } from "react";
import { site } from "@/lib/site";

const secs = (ms?: number) => (ms === undefined ? "n/a" : ms >= 10_000 ? `${(ms / 1000).toFixed(0)} s` : `${(ms / 1000).toFixed(1)} s`);
const money = (n?: number) => (n === undefined ? "n/a" : n >= 1 ? `$${n.toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(4)}`);

/** Providers under load: 100 sandboxes at once, alone, as RL rollouts, or as parallel agents. Most started first. */
export function LoadTable() {
  const kinds = site.load;
  const [id, setId] = useState(kinds[0]?.id);
  const k = kinds.find((x) => x.id === id) ?? kinds[0];
  if (!k) return null;
  const maxP99 = Math.max(...k.rows.map((r) => r.p99Ms ?? 0), 1);
  const chip = (on: boolean) => `rounded-full px-2.5 py-1 text-[12px] ${on ? "bg-accent text-bg" : "text-ink-2 hover:bg-accent-soft hover:text-ink"}`;

  return (
    <div className="mt-6">
      {kinds.length > 1 && (
        <div className="flex flex-wrap items-center gap-1 border-y border-line py-3 text-[12px]">
          <span className="mr-2 text-muted">Load</span>
          {kinds.map((x) => (
            <button key={x.id} aria-pressed={x.id === k.id} onClick={() => setId(x.id)} className={chip(x.id === k.id)}>
              {x.title}
            </button>
          ))}
        </div>
      )}
      <p className="mt-4 text-[14px] text-ink-2">
        {k.blurb} <span className="text-muted">Start times count from the moment all of them were asked for.</span>
      </p>
      <table className="mt-4 w-full text-[14px]">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-[0.12em] text-muted">
            <th className="py-3 pr-4 font-normal">Provider</th>
            <th className="py-3 pr-4 font-normal">Started</th>
            <th className="py-3 pr-4 font-normal">Ready, p50</th>
            <th className="hidden py-3 pr-4 font-normal sm:table-cell">Ready, p99</th>
            <th className="hidden py-3 pr-4 font-normal md:table-cell">All done</th>
            <th className="py-3 font-normal">Cost of all of them</th>
          </tr>
        </thead>
        <tbody>
          {k.rows.map((r) => (
            <tr key={r.provider} className="group border-t border-line">
              <td className="py-3 pr-4">
                <Link href={`/providers/${r.provider}`} className="text-ink group-hover:underline underline-offset-4 decoration-line-2">
                  {r.name}
                </Link>
              </td>
              <td className="py-3 pr-4 font-mono tnum">
                <span className={r.ok === r.n ? "text-ink" : "text-ink-2"}>
                  {r.ok}/{r.n}
                </span>
                {r.limited ? <span className="ml-2 text-[11px] text-muted" title="Refused for a limit or quota on our account">{r.limited} over our account&apos;s limit</span> : null}
              </td>
              <td className="py-3 pr-4 font-mono tnum text-ink">{secs(r.p50Ms)}</td>
              <td className="hidden py-3 pr-4 sm:table-cell">
                <div className="flex items-center gap-3">
                  <span className="w-14 font-mono tnum text-ink-2">{secs(r.p99Ms)}</span>
                  <span className="hidden h-px w-24 bg-line lg:block">
                    <span className="block h-px bg-bar" style={{ width: `${((r.p99Ms ?? 0) / maxP99) * 100}%` }} />
                  </span>
                </div>
              </td>
              <td className="hidden py-3 pr-4 font-mono tnum text-ink-2 md:table-cell">{secs(r.wallMs)}</td>
              <td className="py-3 font-mono tnum text-ink">{money(r.usd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-[12px] text-muted">
        Limits depend on the account&apos;s plan: ours is a standard one. A higher plan can usually start more at once.
      </p>
    </div>
  );
}
