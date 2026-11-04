"use client";

import Link from "next/link";
import { useState } from "react";
import { CAPABILITY_LABEL, DEFAULT_SHAPE, ranked, shapeLabel, site, usd } from "@/lib/site";

const NEEDS = ["pause", "gpu", "custom-image"] as const;

export function ProviderTable() {
  const [shape, setShape] = useState(DEFAULT_SHAPE);
  const [need, setNeed] = useState<string | null>(null);
  const speed = new Map(site.leaderboard.map((r) => [r.provider, r.medianCreateMs]));
  const showSpeed = speed.size > 0;

  const has = (p: (typeof site.providers)[number], c: string) => p.capabilities.includes(c);
  const rows = ranked(shape).filter((p) => !need || has(p, need));
  const cloud = rows.filter((r) => !r.local && !r.prices[shape].unfit);
  const max = Math.max(0.0001, ...cloud.map((r) => r.prices[shape].usd));

  const chip = (on: boolean) => `px-2.5 py-1 text-[12px] tnum ${on ? "bg-ink text-bg" : "text-ink-2 hover:text-ink"}`;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-y border-line py-3 text-[12px]">
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-2 text-muted">Size</span>
          {site.shapes.map((s) => (
            <button key={s} onClick={() => setShape(s)} className={chip(s === shape)}>
              {shapeLabel(s)}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-2 text-muted">Needs</span>
          {NEEDS.map((n) => (
            <button key={n} aria-pressed={need === n} onClick={() => setNeed(need === n ? null : n)} className={chip(need === n)}>
              {CAPABILITY_LABEL[n]}
            </button>
          ))}
        </div>
      </div>

      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-[0.12em] text-muted">
            <th className="py-3 pr-4 font-normal">Provider</th>
            <th className="py-3 pr-4 font-normal">Per hour</th>
            {showSpeed && <th className="hidden py-3 pr-4 font-normal sm:table-cell">Cold start</th>}
            <th className="hidden py-3 font-normal md:table-cell">Supports</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const price = p.prices[shape];
            const pct = p.local || price.unfit ? 0 : Math.max(1.5, (price.usd / max) * 100);
            return (
              <tr key={p.id} className="group border-t border-line">
                <td className="py-3 pr-4">
                  <Link href={`/providers/${p.id}`} className="text-ink group-hover:underline underline-offset-4 decoration-line-2">
                    {p.name}
                  </Link>
                  {p.local && <span className="ml-2 text-[11px] text-muted">opt-in</span>}
                </td>
                <td className="py-3 pr-4">
                  {price.unfit ? (
                    <span className="text-muted">{price.unfit}</span>
                  ) : (
                    <div className="flex items-center gap-3" title={`${p.name}: ${usd(price.usd)} per hour at list price`}>
                      <span className="w-14 font-mono tnum text-ink">{usd(price.usd)}</span>
                      <span className="hidden h-px w-28 bg-line sm:block">
                        <span className="block h-px bg-bar" style={{ width: `${pct}%` }} />
                      </span>
                    </div>
                  )}
                </td>
                {showSpeed && (
                  <td className="hidden py-3 pr-4 font-mono tnum text-ink-2 sm:table-cell">{speed.get(p.id) ? `${speed.get(p.id)} ms` : "—"}</td>
                )}
                <td className="hidden py-3 text-ink-2 md:table-cell">
                  {p.capabilities.map((c) => CAPABILITY_LABEL[c] ?? c).join(" · ") || "—"}
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr className="border-t border-line">
              <td colSpan={4} className="py-8 text-center text-muted">
                No provider supports that yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="mt-4 text-[12px] leading-5 text-muted">
        Sorted the way the router picks: lowest list price for the size, ties alphabetical. Prices are each provider&apos;s public
        rate while running; some bill only active CPU, so idle work costs less. Docker runs on your own machine and is only used
        when you ask for it.
      </p>
    </div>
  );
}
