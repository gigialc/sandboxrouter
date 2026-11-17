"use client";

import { useState } from "react";
import { ConditionalStartFeeNote } from "@/components/ConditionalStartFeeNote";
import { BarNum, Footnote, Num, ResultRow, ResultTable, Segmented, Toolbar, barMax, money, perHour } from "@/components/results";
import { site } from "@/lib/site";

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
const runLength = (s: number) => (s < 60 ? plural(s, "second") : s < 3600 ? plural(Math.round(s / 60), "minute") : plural(Math.round(s / 3600), "hour"));

/** Estimated cost for each kind of run before account-specific fees. */
export function UseCaseTable() {
  const [id, setId] = useState(site.useCases[0]?.id);
  const u = site.useCases.find((x) => x.id === id) ?? site.useCases[0];
  if (!u) return null;
  const max = barMax(u.top.map((r) => r.runUsd));
  const spec = [
    `${u.spec.vcpu} vCPU / ${u.spec.memoryGb} GB`,
    runLength(u.runSeconds),
    u.spec.cpuUtilization !== undefined && u.spec.cpuUtilization < 1 ? `${Math.round(u.spec.cpuUtilization * 100)}% CPU` : "",
    u.require.length ? `needs ${u.require.join(", ")}` : "",
  ].filter(Boolean);

  return (
    <div>
      <Toolbar note={`${u.blurb} ${spec.join(" · ")}.`}>
        <Segmented label="Job" options={site.useCases.map((x) => [x.id, x.title] as const)} value={u.id} onChange={setId} />
      </Toolbar>
      <ResultTable cols={[{ label: "Est. / 1,000 runs" }, { label: "Per hour", className: "hidden sm:table-cell" }]}>
        {u.top.map((r, i) => (
          <ResultRow
            key={r.provider}
            rank={i + 1}
            id={r.provider}
            name={r.name}
            notes={[
              r.minimumSeconds > u.runSeconds ? `bills at least ${r.minimumSeconds} s` : "",
              r.perSandboxUsd ? `+${money(r.perSandboxUsd)} per sandbox` : "",
            ].filter(Boolean)}
          >
            <BarNum value={r.runUsd} max={max} title={`${r.name}: ${money(r.runUsd)} for one run of ${runLength(u.runSeconds)}`}>
              {money(r.runUsd * 1000)}
            </BarNum>
            <Num className="hidden sm:table-cell">{perHour(r.runHourlyUsd)}</Num>
          </ResultRow>
        ))}
      </ResultTable>
      {u.top.some((r) => r.provider === "boat") && (
        <Footnote><ConditionalStartFeeNote id="boat" /></Footnote>
      )}
    </div>
  );
}
