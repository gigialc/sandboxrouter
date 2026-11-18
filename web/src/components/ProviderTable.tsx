"use client";

import Link from "next/link";
import { useState } from "react";
import { BarNum, Footnote, Num, ResultRow, ResultTable, Segmented, Toolbar, Txt, barMax, perHour, time } from "@/components/results";
import { startFeeNote } from "@/components/ConditionalStartFeeNote";
import { CAPABILITY_LABEL, DEFAULT_SHAPE, OWN_IMAGE_NOTE, ranked, shapeLabel, site, usd, type Shape } from "@/lib/site";

const NEEDS = ["pause", "ports", "background", "gpu", "custom-image"] as const;

/** Every provider's list price at a size, cheapest first, in the same table style as the benchmarks. */
export function ProviderTable() {
  const [shape, setShape] = useState<Shape>(DEFAULT_SHAPE);
  const [need, setNeed] = useState<string>("any");
  const [tested, setTested] = useState<"all" | "passed">("all");
  const starts = new Map(site.leaderboard.map((r) => [r.provider, r]));
  const [shapeVcpu, shapeGb] = shape.split("x").map(Number);
  const has = (p: (typeof site.providers)[number], c: string) => p.capabilities.includes(c);
  // The real-account filter lists hosted providers only, like its count: local Docker has no account to test.
  const rows = ranked(shape).filter((p) => (need === "any" || has(p, need)) && (tested === "all" || (!p.local && p.live.status === "passed")));
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
          { label: "Create call", className: "hidden sm:table-cell" },
          { label: "Plan", left: true, className: "hidden md:table-cell" },
          { label: "Real account", left: true, className: "hidden md:table-cell" },
          { label: "Supports", left: true, className: "hidden lg:table-cell" },
        ]}
      >
        {rows.map((p, i) => {
          const price = p.prices[shape];
          const d = p.defaultSize;
          const defaultImage = d ? `${d.vcpu} vCPU · ${d.memoryGb} GB` : "";
          const start = starts.get(p.id);
          // The create timing's size, when it isn't the size this table is set to.
          const startSize = start && (start.size.vcpu !== shapeVcpu || start.size.memoryGb !== shapeGb) ? `${start.size.vcpu} vCPU · ${start.size.memoryGb} GB` : "";
          const notes = [
            p.local ? "opt-in, runs on your machine" : "",
            p.access ? (p.access.status === "waitlist" ? "sign-up waitlisted" : "not taking new accounts") : "",
            price.ownImage ? OWN_IMAGE_NOTE : "",
            price.ownImage && d ? `default image is ${defaultImage}` : "",
            p.local ? "" : startFeeNote(p.id),
            p.billing === "active-cpu" ? "CPU billed only while busy" : "",
          ].filter(Boolean);
          return (
            <ResultRow key={p.id} rank={p.local || price.unfit ? 0 : i + 1} id={p.id} name={p.name} notes={notes} dim={!!p.access}>
              {price.unfit ? (
                <Txt className="text-right text-muted">{price.unfit}</Txt>
              ) : p.local ? (
                <Num>$0</Num>
              ) : (
                <BarNum
                  value={price.usd}
                  max={max}
                  title={
                    price.ownImage && d
                      ? `${p.name}: ${usd(price.usd)} per hour at list price from your own image; its default image is ${defaultImage} at ${usd(d.usd)} per hour`
                      : p.billing === "active-cpu"
                        ? `${p.name}: ${usd(price.usd)} per hour with every core busy; less when idle`
                        : `${p.name}: ${usd(price.usd)} per hour at list price`
                  }
                >
                  {p.billing === "active-cpu" ? "≤ " : ""}
                  {perHour(price.usd)}
                </BarNum>
              )}
              <Num
                className="hidden sm:table-cell"
                title={start?.medianCreateMs ? `Median time for the create call to return, measured at ${start.size.vcpu} vCPU · ${start.size.memoryGb} GB` : undefined}
              >
                {start?.medianCreateMs ? time(start.medianCreateMs) : "—"}
                {start?.medianCreateMs && startSize ? <span className="block font-sans text-[11px] text-muted">at {startSize}</span> : null}
              </Num>
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
        billed only while busy, so an idle sandbox costs less. Create call is the median time for the create request to return, one
        request at a time; a size under it means it was measured at that size, not the one selected. &ldquo;Not yet&rdquo; means tested
        against mocks only. The real-account filter lists hosted providers only, so local Docker is left out.{" "}
        <Link href="/docs#price-table" className="underline decoration-line-2 underline-offset-2 hover:text-ink">
          How to read this table
        </Link>
      </Footnote>
    </div>
  );
}
