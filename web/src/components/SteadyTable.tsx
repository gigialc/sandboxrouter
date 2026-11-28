import { ConditionalStartFeeNote, hasStartFee } from "@/components/ConditionalStartFeeNote";
import { BarNum, Footnote, Num, ResultRow, ResultTable, Toolbar, barMax, perHour, time } from "@/components/results";
import { site, sizeNote } from "@/lib/site";

const pct = (x: number) => `${x < 0.0995 ? (x * 100).toFixed(1) : Math.round(x * 100)}%`;

/**
 * One sandbox per provider, kept running, doing the same one-core job at a fixed interval.
 * Ranked by how far the slow samples fall behind the typical one: steadiest first.
 */
export function SteadyTable() {
  const rows = site.steady;
  if (!rows.length) return null;
  const max = barMax(rows.map((r) => r.spread));
  const dates = [...new Set(rows.map((r) => r.measuredAt.slice(0, 10)))].sort();
  const measured = dates.length > 1 ? `${dates[0]} to ${dates.at(-1)}` : dates[0];
  const { samples, intervalSeconds } = rows[0];
  const ids = rows.map((r) => r.provider);

  return (
    <div>
      <Toolbar note={
        <>
          {rows.length} providers, one sandbox per run, {samples} samples {intervalSeconds} seconds apart
          {measured ? `, measured ${measured}` : ""}. Each sample hashes 1 GB on one core and is timed by the sandbox&apos;s own clock.
        </>
      }>
        {null}
      </Toolbar>
      <ResultTable
        cols={[
          { label: "Slow samples vs typical" },
          { label: "Typical sample" },
          { label: "Slowest sample", className: "hidden sm:table-cell" },
          { label: "Per hour", className: "hidden md:table-cell" },
        ]}
      >
        {rows.map((r, i) => (
          <ResultRow key={r.provider} rank={i + 1} id={r.provider} name={r.name} notes={[sizeNote(r.size), r.runs > 1 ? `${r.runs} runs: ${r.spreads.map((s) => `+${pct(s)}`).join(", ")}` : "1 run"].filter(Boolean)}>
            <BarNum value={r.spread} max={max} title={`${r.name}: 95th percentile sample against the median one, ${r.runs > 1 ? `median of ${r.runs} runs` : "one run"}`}>
              +{pct(r.spread)}
            </BarNum>
            <Num title="Median sample">{time(r.medianMs)}</Num>
            <Num className="hidden sm:table-cell" title={`The slowest sample of any run, ${pct(r.maxMs / r.medianMs - 1)} slower than the median one`}>{time(r.maxMs)}</Num>
            <Num className="hidden md:table-cell">{perHour(r.hourlyUsd)}</Num>
          </ResultRow>
        ))}
      </ResultTable>
      <Footnote>
        Slow samples vs typical is how much longer the 95th percentile sample took than the median one: the lower, the steadier.
        It says nothing about speed, which is the typical sample. Each run is one sandbox for {Math.round((samples * intervalSeconds) / 60)} minutes
        on a machine that other customers share, so runs differ: the figure is the median across a provider&apos;s runs, and each run&apos;s own
        figure is under its name.
        {hasStartFee(ids) && <> <ConditionalStartFeeNote ids={ids} what="hourly prices" /></>}
      </Footnote>
    </div>
  );
}
