"use client";

import { useState } from "react";
import { BarNum, Footnote, Num, ResultRow, ResultTable, Segmented, Toolbar, barMax, money, time } from "@/components/results";
import { site, type LoadRow } from "@/lib/site";

/** Cost scaled to 100 sandboxes from the ones that ran, so providers that started fewer compare fairly. */
const per100 = (r: LoadRow) => (r.usd === undefined || !r.ok ? undefined : (r.usd / r.ok) * 100);

/**
 * Providers under load. Two sizes: 10 at once, which every account allows, so everyone faces the same load; and
 * 100 at once, how fast and steady each provider is at scale. Only providers measured at the full size are ranked;
 * ones our test account's limit held back are named apart, since that limit is ours, not theirs.
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
  const max = barMax(full.map((r) => r.p50Ms ?? 0));

  return (
    <div>
      <Toolbar note={`${k.blurb} Start times count from the moment all of them were asked for.`}>
        <Segmented label="At once" options={sizes.map((s) => [s, String(s)] as const)} value={n} onChange={setN} />
        <Segmented label="Job" options={jobs.map((x) => [x.job, x.title] as const)} value={k.job} onChange={setJob} />
      </Toolbar>
      <ResultTable
        cols={[
          { label: "Ready, median" },
          { label: "Slowest 1%", className: "hidden sm:table-cell" },
          { label: "All done", className: "hidden md:table-cell" },
          { label: "Per 100" },
        ]}
      >
        {full.map((r, i) => (
          <ResultRow key={r.provider} rank={i + 1} id={r.provider} name={r.name}>
            <BarNum value={r.p50Ms ?? 0} max={max}>
              {time(r.p50Ms)}
            </BarNum>
            <Num className="hidden sm:table-cell">{time(r.p99Ms)}</Num>
            <Num className="hidden md:table-cell">{time(r.wallMs)}</Num>
            <Num>{money(per100(r))}</Num>
          </ResultRow>
        ))}
      </ResultTable>
      <Footnote>
        {partial.length > 0
          ? `Not measured at ${k.n} yet: ${partial.map((r) => r.name).join(", ")}. Our test account's limit stopped these, not the provider. `
          : ""}
        Cost per 100 is scaled from the sandboxes that ran.
      </Footnote>
    </div>
  );
}
