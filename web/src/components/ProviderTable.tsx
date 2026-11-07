"use client";

import Link from "next/link";
import { useState } from "react";
import { CAPABILITY_LABEL, DEFAULT_SHAPE, fixedPrice, ranked, shapeLabel, site, usd } from "@/lib/site";

const NEEDS = ["pause", "gpu", "custom-image"] as const;

export function ProviderTable() {
  const [shape, setShape] = useState(DEFAULT_SHAPE);
  const [need, setNeed] = useState<string | null>(null);
  const [tested, setTested] = useState(false);
  const speed = new Map(site.leaderboard.map((r) => [r.provider, r.medianCreateMs]));
  const showSpeed = speed.size > 0;

  const has = (p: (typeof site.providers)[number], c: string) => p.capabilities.includes(c);
  const rows = ranked(shape).filter((p) => (!need || has(p, need)) && (!tested || p.live.status === "passed"));
  const passing = site.providers.filter((p) => !p.local && p.live.status === "passed").length;
  const cloud = rows.filter((r) => !r.local && !r.prices[shape].unfit);
  const max = Math.max(0.0001, ...cloud.map((r) => r.prices[shape].usd));

  const chip = (on: boolean) => `rounded-full px-2.5 py-1 text-[12px] tnum ${on ? "bg-accent text-white" : "text-ink-2 hover:bg-accent-soft hover:text-ink"}`;

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
        <button aria-pressed={tested} onClick={() => setTested(!tested)} className={`${chip(tested)} sm:ml-auto`}>
          Passed on a real account ({passing})
        </button>
      </div>

      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-[0.12em] text-muted">
            <th className="py-3 pr-4 font-normal">Provider</th>
            <th className="py-3 pr-4 font-normal">List price / hr</th>
            <th className="hidden py-3 pr-4 font-normal sm:table-cell">Plan needed</th>
            {showSpeed && <th className="hidden py-3 pr-4 font-normal sm:table-cell">Cold start</th>}
            <th className="hidden py-3 pr-4 font-normal md:table-cell">Real account</th>
            <th className="hidden py-3 font-normal lg:table-cell">Supports</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const price = p.prices[shape];
            const fixed = fixedPrice(p, shape);
            const pct = p.local || price.unfit ? 0 : Math.max(1.5, (price.usd / max) * 100);
            return (
              <tr key={p.id} className="group border-t border-line">
                <td className="py-3 pr-4">
                  <Link href={`/providers/${p.id}`} className="text-ink group-hover:underline underline-offset-4 decoration-line-2">
                    {p.name}
                  </Link>
                  {p.local && <span className="ml-2 text-[11px] text-muted">opt-in</span>}
                  {p.access && (
                    <span className="ml-2 text-[11px] text-muted" title={p.access.note}>
                      {p.access.status === "waitlist" ? "waitlist" : "no new accounts"}
                    </span>
                  )}
                </td>
                <td className="py-3 pr-4">
                  {fixed ? (
                    <div
                      className="flex items-center gap-3"
                      title={`${p.name}'s default image is ${fixed.size} whatever size you ask for; a bigger size needs a custom image (image.${p.id}). This is its price at ${fixed.size}.`}
                    >
                      <span className="w-20 font-mono tnum text-ink-2">{usd(fixed.usd)}</span>
                      <span className="text-[12px] text-muted">at {fixed.size} only</span>
                    </div>
                  ) : price.unfit ? (
                    <span className="text-muted">{price.unfit}</span>
                  ) : (
                    <div
                      className="flex items-center gap-3"
                      title={
                        p.billing === "active-cpu"
                          ? `${p.name}: CPU is billed only while busy; ${usd(price.usd)} is the price with every core busy`
                          : `${p.name}: ${usd(price.usd)} per hour at list price`
                      }
                    >
                      <span className="w-20 font-mono tnum text-ink">
                        {p.billing === "active-cpu" && <span className="mr-1 text-[11px] text-muted">≤</span>}
                        {usd(price.usd)}
                      </span>
                      <span className="hidden h-px w-28 bg-line sm:block">
                        <span className="block h-px bg-bar" style={{ width: `${pct}%` }} />
                      </span>
                    </div>
                  )}
                </td>
                <td className="hidden py-3 pr-4 text-ink-2 sm:table-cell" title={p.plan?.note}>
                  {p.planLabel}
                </td>
                {showSpeed && (
                  <td className="hidden py-3 pr-4 font-mono tnum text-ink-2 sm:table-cell">{speed.get(p.id) ? `${speed.get(p.id)} ms` : "—"}</td>
                )}
                <td className="hidden py-3 pr-4 md:table-cell">
                  <span className={p.live.status === "passed" ? "text-ink" : "text-muted"}>
                    {p.live.status === "passed" ? "passed" : p.live.status === "failing" ? "failed last run" : "not yet"}
                  </span>
                </td>
                <td className="hidden py-3 text-ink-2 lg:table-cell">
                  {p.capabilities.map((c) => CAPABILITY_LABEL[c] ?? c).join(" · ") || "—"}
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr className="border-t border-line">
              <td colSpan={6} className="py-8 text-center text-muted">
                {tested ? "No provider with that has passed on a real account yet." : "No provider supports that yet."}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="mt-4 text-[12px] leading-5 text-muted">
        Providers anyone can sign up for come first, cheapest first, ties alphabetical; waitlisted or closed sign-ups follow. The
        router uses the same price order, but only among providers you have keys for. Prices are each provider&apos;s public list
        price while running, an estimate rather than a bill (where they come from is below). ≤ means CPU is billed only while busy, so this is the price with every core busy and idle work costs less.
        Plan needed is the monthly plan required before the API creates sandboxes (&ldquo;credited&rdquo; = paid back as usage);
        for a small project it can cost more than the usage. Real account shows whether the 14-step check has passed on a real
        account; &ldquo;not yet&rdquo; means the adapter is built from the provider&apos;s docs and tested against mocks only.
        {showSpeed && (
          <>
            {" "}
            Cold starts are medians from the benchmark reports submitted so far ({site.submissions.length}{" "}
            {site.submissions.length === 1 ? "report, from one machine" : "reports"}), so treat them as a rough guide.
          </>
        )}{" "}
        Docker runs on your own machine and is only used when you ask for it.
      </p>
    </div>
  );
}
