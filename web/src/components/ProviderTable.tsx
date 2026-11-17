"use client";

import Link from "next/link";
import { useState } from "react";
import { BarNum, Footnote, Num, ResultRow, ResultTable, Segmented, Toolbar, Txt, barMax, perHour, time } from "@/components/results";
import { CAPABILITY_LABEL, DEFAULT_SHAPE, fixedPrice, ranked, shapeLabel, site, usd, type Shape } from "@/lib/site";

const NEEDS = ["pause", "gpu", "custom-image"] as const;

/** Every provider's list price at a size, cheapest first, in the same table style as the benchmarks. */
export function ProviderTable() {
  const [shape, setShape] = useState<Shape>(DEFAULT_SHAPE);
  const [need, setNeed] = useState<string>("any");
  const [tested, setTested] = useState<"all" | "passed">("all");
  const speed = new Map(site.leaderboard.map((r) => [r.provider, r.medianCreateMs]));
  const has = (p: (typeof site.providers)[number], c: string) => p.capabilities.includes(c);
  const rows = ranked(shape).filter((p) => (need === "any" || has(p, need)) && (tested === "all" || p.live.status === "passed"));
  const passing = site.providers.filter((p) => !p.local && p.live.status === "passed").length;
  const max = barMax(rows.filter((r) => !r.local && !r.prices[shape].unfit).map((r) => r.prices[shape].usd));

  return (
    <div>
      <Toolbar>
        <Segmented label="Size" options={site.shapes.map((s) => [s as Shape, shapeLabel(s as Shape)] as const)} value={shape} onChange={setShape} />
        <Segmented
          label="Needs"
          options={[["any", "Anything"] as const, ...NEEDS.map((n) => [n, CAPABILITY_LABEL[n]] as const)]}
          value={need}
          onChange={setNeed}
        />
        <Segmented
          label="Tested"
          options={[
            ["all", "All"],
            ["passed", `Passed on a real account (${passing})`],
          ]}
          value={tested}
          onChange={setTested}
        />
      </Toolbar>

      <ResultTable
        wide
        cols={[
          { label: "Per hour" },
          { label: "Starts in", className: "hidden sm:table-cell" },
          { label: "Plan", left: true, className: "hidden md:table-cell" },
          { label: "Real account", left: true, className: "hidden md:table-cell" },
          { label: "Supports", left: true, className: "hidden lg:table-cell" },
        ]}
      >
        {rows.map((p, i) => {
          const price = p.prices[shape];
          const fixed = fixedPrice(p, shape);
          const notes = [
            p.local ? "opt-in, runs on your machine" : "",
            p.access ? (p.access.status === "waitlist" ? "sign-up waitlisted" : "not taking new accounts") : "",
            fixed ? `default template is ${fixed.size}` : "",
            p.pricing.conditionalStartFee ? "extra start fees above plan allowance" : "",
            p.billing === "active-cpu" ? "CPU billed only while busy" : "",
          ].filter(Boolean);
          return (
            <ResultRow key={p.id} rank={p.local || price.unfit ? 0 : i + 1} id={p.id} name={p.name} notes={notes} dim={!!p.access}>
              {fixed ? (
                <Num title={`${p.name}'s default image is ${fixed.size} whatever size you ask for; this is its price at that size.`}>{perHour(fixed.usd)}</Num>
              ) : price.unfit ? (
                <Txt className="text-right text-muted">{price.unfit}</Txt>
              ) : p.local ? (
                <Num>$0</Num>
              ) : (
                <BarNum
                  value={price.usd}
                  max={max}
                  title={p.billing === "active-cpu" ? `${p.name}: ${usd(price.usd)} per hour with every core busy; less when idle` : `${p.name}: ${usd(price.usd)} per hour at list price`}
                >
                  {p.billing === "active-cpu" ? "≤ " : ""}
                  {perHour(price.usd)}
                </BarNum>
              )}
              <Num className="hidden sm:table-cell">{speed.get(p.id) ? time(speed.get(p.id)) : "—"}</Num>
              <Txt className="hidden md:table-cell" title={p.plan?.note}>
                {p.planLabel}
              </Txt>
              <Txt className="hidden md:table-cell">
                <span className={p.live.status === "passed" ? "text-ink" : "text-muted"}>
                  {p.live.status === "passed" ? "passed" : p.live.status === "failing" ? "failed last run" : "not yet"}
                </span>
              </Txt>
              <Txt className="hidden lg:table-cell">{p.capabilities.map((c) => CAPABILITY_LABEL[c] ?? c).join(" · ") || "—"}</Txt>
            </ResultRow>
          );
        })}
      </ResultTable>
      {rows.length === 0 ? <p className="mt-6 text-[14px] text-muted">No provider matches that yet.</p> : null}
      <Footnote>
        Cheapest first, open sign-ups before waitlisted ones; the router tries ones that passed on a real account first. ≤ means CPU is
        billed only while busy, so an idle sandbox costs less. &ldquo;Not yet&rdquo; means tested against mocks only.{" "}
        <Link href="/docs#price-table" className="underline decoration-line-2 underline-offset-2 hover:text-ink">
          How to read this table
        </Link>
      </Footnote>
    </div>
  );
}
