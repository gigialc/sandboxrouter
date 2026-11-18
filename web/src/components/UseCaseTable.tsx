"use client";

import { useState } from "react";
import { ConditionalStartFeeNote, hasStartFee } from "@/components/ConditionalStartFeeNote";
import { BarNum, Footnote, Num, ResultRow, ResultTable, Segmented, Toolbar, barMax, money, perHour } from "@/components/results";
import { site } from "@/lib/site";

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
const runLength = (s: number) => (s < 60 ? plural(s, "second") : s < 3600 ? plural(Math.round(s / 60), "minute") : plural(Math.round(s / 3600), "hour"));

/** Estimated cost for each kind of run before account-specific fees. */
export function UseCaseTable() {
  const [id, setId] = useState(site.useCases[0]?.id);
  const [showAll, setShowAll] = useState(false);
  const u = site.useCases.find((x) => x.id === id) ?? site.useCases[0];
  if (!u) return null;
  const max = barMax(u.top.map((r) => r.runUsd));
  const rows = showAll ? u.top : u.top.slice(0, 8);
  const spec = [
    `${u.spec.vcpu} vCPU / ${u.spec.memoryGb} GB`,
    runLength(u.runSeconds),
    u.spec.cpuUtilization !== undefined && u.spec.cpuUtilization < 1 ? `${Math.round(u.spec.cpuUtilization * 100)}% CPU` : "",
    u.require.length ? `needs ${u.require.join(", ")}` : "",
  ].filter(Boolean);

  return (
    <div>
      <Toolbar note={`${u.blurb} ${spec.join(" · ")}. ${u.top.length} ${u.top.length === 1 ? "provider fits" : "providers fit"} this request and passed the real-account check.`}>
        <Segmented label="Job" options={site.useCases.map((x) => [x.id, x.title] as const)} value={u.id} onChange={setId} />
      </Toolbar>
      <ResultTable cols={[{ label: "Est. / 1,000 runs" }, { label: "Per hour", className: "hidden sm:table-cell" }]}>
        {rows.map((r, i) => (
          <ResultRow
            key={r.provider}
            rank={i + 1}
            id={r.provider}
            name={r.name}
            notes={[
              r.minimumSeconds > u.runSeconds ? `bills at least ${r.minimumSeconds} s` : "",
              r.perSandboxUsd ? `+${money(r.perSandboxUsd)} per sandbox` : "",
              r.ownImage ? "needs your own image at this size" : "",
            ].filter(Boolean)}
          >
            <BarNum value={r.runUsd} max={max} title={`${r.name}: ${money(r.runUsd)} for one run of ${runLength(u.runSeconds)}`}>
              {money(r.runUsd * 1000)}
            </BarNum>
            <Num className="hidden sm:table-cell">{perHour(r.runHourlyUsd)}</Num>
          </ResultRow>
        ))}
      </ResultTable>
      {u.top.length > 8 && (
        <button type="button" aria-expanded={showAll} onClick={() => setShowAll((expanded) => !expanded)} className="mt-3 text-[13px] text-ink-2 underline underline-offset-4 decoration-line-2 hover:text-ink">
          {showAll ? "Show fewer" : `Show all ${u.top.length} providers`}
        </button>
      )}
      {hasStartFee(rows.map((r) => r.provider)) && <Footnote><ConditionalStartFeeNote ids={rows.map((r) => r.provider)} /></Footnote>}
    </div>
  );
}
