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
          { label: "1,000 sessions" },
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
              notes={r.limited ? [`${r.limited} more refused for our account's limit`] : undefined}
            >
              <BarNum value={r.medianUsd ?? 0} max={max}>
                {money(r.medianUsd === undefined ? undefined : r.medianUsd * 1000)}
              </BarNum>
              <Num>
                {r.ok}/{r.runs}
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
        {rows[0].model}, the same task each time. The sandbox&apos;s cost only, not the model&apos;s. Idle is the share of the session spent
        waiting on the model.
      </Footnote>
    </div>
  );
}
