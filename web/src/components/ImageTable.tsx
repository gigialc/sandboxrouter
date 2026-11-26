"use client";

import { useState } from "react";
import { ConditionalStartFeeNote, hasStartFee } from "@/components/ConditionalStartFeeNote";
import { BarNum, Footnote, Num, ResultRow, ResultTable, Segmented, Toolbar, barMax, perHour, time } from "@/components/results";
import { site } from "@/lib/site";

/**
 * Starting a sandbox straight from a public registry image, with no template or snapshot step.
 * Ranked by the starts after the first one, which is what a job pays for every time.
 */
export function ImageTable() {
  const tables = site.image;
  const [image, setImage] = useState(tables[0]?.image);
  const t = tables.find((x) => x.image === image) ?? tables[0];
  if (!t) return null;
  const max = barMax(t.rows.map((r) => r.medianRepeatCreateMs ?? 0));
  const dates = [...new Set(t.rows.map((r) => r.measuredAt.slice(0, 10)))].sort();
  const measured = dates.length > 1 ? `${dates[0]} to ${dates.at(-1)}` : dates[0];
  const ids = t.rows.map((r) => r.provider);

  return (
    <div>
      <Toolbar note={
        <>
          {t.rows.length} providers started <code className="font-mono text-[12px]">{t.image}</code> from its registry address at{" "}
          {t.spec.vcpu} vCPU / {t.spec.memoryGb} GB{measured ? `, measured ${measured}` : ""}. Every sandbox was checked to be that image.
        </>
      }>
        {tables.length > 1 && <Segmented label="Image" options={tables.map((x) => [x.image, x.image] as const)} value={t.image} onChange={setImage} />}
      </Toolbar>
      <ResultTable
        cols={[
          { label: "Later starts, median" },
          { label: "First start" },
          { label: "Per hour", className: "hidden sm:table-cell" },
        ]}
      >
        {t.rows.map((r, i) => (
          <ResultRow key={r.provider} rank={i + 1} id={r.provider} name={r.name} notes={[`${r.verified} of ${r.verified + r.failures} starts verified`]}>
            <BarNum value={r.medianRepeatCreateMs ?? 0} max={max} title={`${r.name}: ${r.repeatCreateMs.map((ms) => time(ms)).join(", ")}`}>
              {time(r.medianRepeatCreateMs)}
            </BarNum>
            <Num title="One observation: the provider pulls and prepares the image the first time it sees it">{time(r.firstCreateMs)}</Num>
            <Num className="hidden sm:table-cell">{perHour(r.hourlyUsd)}</Num>
          </ResultRow>
        ))}
      </ResultTable>
      <Footnote>
        The first start is a single observation and grows with the size of the image. Later starts are the median of {t.repeats}.
        Per hour is the list price at the size shown. Providers that need the image rebuilt as their own template or snapshot first are not in this table.
        {hasStartFee(ids) && <> <ConditionalStartFeeNote ids={ids} what="hourly prices" /></>}
      </Footnote>
    </div>
  );
}
