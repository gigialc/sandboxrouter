"use client";

import Link from "next/link";
import { ProviderName } from "@/components/ProviderName";
import { useState } from "react";
import { site, type LoadRow } from "@/lib/site";

const secs = (ms?: number) => (ms === undefined ? "n/a" : ms >= 10_000 ? `${(ms / 1000).toFixed(0)} s` : `${(ms / 1000).toFixed(1)} s`);
const money = (n?: number) =>
  n === undefined ? "n/a" : n >= 1 ? `$${n.toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(3)}` : `$${Number(n.toPrecision(2)).toFixed(Math.max(2, 1 - Math.floor(Math.log10(n))))}`;
/** Cost scaled to 100 sandboxes from the ones that ran, so providers that started fewer compare fairly. */
const per100 = (r: LoadRow) => (r.usd === undefined || !r.ok ? undefined : (r.usd / r.ok) * 100);

/**
 * Providers under load. Two sizes: 10 at once, which every account allows, so everyone faces the same load; and
 * 100 at once, which shows how fast and steady each provider is at scale. Only providers measured at the full size are
 * ranked; ones our test account's limit held back are named apart as not measured yet, since that limit is ours, not
 * theirs (larger accounts get higher limits).
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
  const maxP99 = Math.max(...k.rows.map((r) => r.p99Ms ?? 0), 1);
  const chip = (on: boolean) => `rounded-full px-2.5 py-1 text-[12px] ${on ? "bg-accent text-bg" : "text-ink-2 hover:bg-accent-soft hover:text-ink"}`;

  const row = (r: LoadRow, i?: number) => (
    <tr key={r.provider} className="group border-t border-line">
      <td className="w-10 py-3 pr-2 font-mono text-[12px] text-muted">{i === undefined ? "" : i + 1}</td>
      <td className="py-3 pr-4">
        <ProviderName id={r.provider} name={r.name} />
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
      <td className="py-3 font-mono tnum text-ink">{money(per100(r))}</td>
    </tr>
  );

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-y border-line py-3 text-[12px]">
        {sizes.length > 1 && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-2 text-muted">At once</span>
            {sizes.map((s) => (
              <button key={s} aria-pressed={s === n} onClick={() => setN(s)} className={chip(s === n)}>
                {s === sizes[0] ? `${s}` : `${s}: at scale`}
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-2 text-muted">Job</span>
          {jobs.map((x) => (
            <button key={x.job} aria-pressed={x.job === k.job} onClick={() => setJob(x.job)} className={chip(x.job === k.job)}>
              {x.title}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-4 text-[14px] text-ink-2">
        {k.blurb}{" "}
        <span className="text-muted">
          Start times count from the moment all of them were asked for. Ranked by the median, among providers that started all {k.n}.
        </span>
      </p>
      <table className="mt-4 w-full text-[14px]">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-[0.12em] text-muted">
            <th className="w-10 py-3 pr-2 font-normal">#</th>
            <th className="py-3 pr-4 font-normal">Provider</th>
            <th className="py-3 pr-4 font-normal">Ready, p50</th>
            <th className="hidden py-3 pr-4 font-normal sm:table-cell">Ready, p99</th>
            <th className="hidden py-3 pr-4 font-normal md:table-cell">All done</th>
            <th className="py-3 font-normal">Cost per 100</th>
          </tr>
        </thead>
        <tbody>
          {full.map((r, i) => row(r, i))}
        </tbody>
      </table>
      {partial.length > 0 && (
        <p className="mt-4 text-[13px] text-ink-2">
          <span className="text-muted">Not measured at {k.n} yet:</span> {partial.map((r) => r.name).join(", ")}.{" "}
          <span className="text-muted">Our test account&apos;s limit stopped these before {k.n}; that limit is ours, not the provider&apos;s, and larger accounts get higher ones.</span>
        </p>
      )}
      <p className="mt-3 text-[12px] text-muted">Cost per 100 is scaled from the sandboxes that ran.</p>
    </div>
  );
}
