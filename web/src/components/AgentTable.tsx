import { ConditionalStartFeeNote } from "@/components/ConditionalStartFeeNote";
import { BarNum, Footnote, Num, ResultRow, ResultTable, barMax, money, time } from "@/components/results";
import { site } from "@/lib/site";

/** A real model doing the same task in a sandbox on each provider: cheapest per session first. */
export function AgentTable() {
  const rows = site.agent;
  if (!rows.length) return null;
  const max = barMax(rows.map((r) => r.medianUsd ?? 0));
  return (
    <div className="mt-6">
      <ResultTable
        cols={[
          { label: "Est. / 1,000 sessions" },
          { label: "Done right" },
          { label: "Session", className: "hidden sm:table-cell" },
          { label: "Idle", className: "hidden md:table-cell" },
        ]}
      >
        {rows.map((r, i) => {
          const idle = r.medianWallMs && r.medianModelMs ? Math.round((r.medianModelMs / r.medianWallMs) * 100) : undefined;
          return (
            <ResultRow
              key={r.provider}
              rank={i + 1}
              id={r.provider}
              name={r.name}
              notes={[
                r.started !== undefined ? `${r.started} started` : "",
                r.limited ? `${r.limited} reported limit refusals` : "",
              ].filter(Boolean)}
            >
              <BarNum value={r.medianUsd ?? 0} max={max}>
                {money(r.medianUsd === undefined ? undefined : r.medianUsd * 1000)}
              </BarNum>
              <Num>
                {r.ok}/{r.requested ?? r.runs}
              </Num>
              <Num className="hidden sm:table-cell" title={`${r.medianTurns ?? "?"} turns`}>
                {time(r.medianWallMs)}
              </Num>
              <Num className="hidden md:table-cell">{idle === undefined ? "n/a" : `${idle}%`}</Num>
            </ResultRow>
          );
        })}
      </ResultTable>
      <Footnote>
        Model: {rows[0].model}. Costs estimate sandbox usage. Idle is the share of the session spent waiting on the model.
        {rows.some((r) => r.provider === "boat") && <> <ConditionalStartFeeNote id="boat" /></>}
      </Footnote>
    </div>
  );
}
