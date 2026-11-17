"use client";

import { useState } from "react";
import { BarNum, Footnote, ResultRow, ResultTable, Segmented, Toolbar, Txt, barMax, perHour } from "@/components/results";
import { site, usd } from "@/lib/site";

const OSES = [
  ["linux", "Linux"],
  ["windows", "Windows"],
  ["android", "Android"],
  ["ios", "iOS"],
] as const;
type Os = (typeof OSES)[number][0];

/** Desktops and phones for one OS, cheapest first, in the same table style as the sandbox table above it. */
export function DesktopTable() {
  const [os, setOs] = useState<Os>("linux");
  const [takeover, setTakeover] = useState<"any" | "yes">("any");
  const label = OSES.find(([id]) => id === os)![1];
  const keep = (d: (typeof site.desktops)[number]) => takeover === "any" || d.takeover;
  const priced = site.desktops.filter((d) => d.os[os] !== undefined && keep(d)).sort((a, b) => a.os[os]! - b.os[os]!);
  const planOnly = site.desktops.filter((d) => d.os[os] === undefined && d.planOnly?.includes(os) && keep(d));
  const max = barMax(priced.map((d) => d.os[os]!));
  const count = (o: Os) => site.desktops.filter((d) => d.os[o] !== undefined || d.planOnly?.includes(o)).length;
  // Desktop-only providers have no sandbox page; their name links to their docs.
  const href = (d: (typeof site.desktops)[number]) => (site.providers.some((p) => p.id === d.id) ? `/providers/${d.id}` : d.docs);
  const others = (d: (typeof site.desktops)[number]) =>
    OSES.filter(([o]) => o !== os && d.os[o] !== undefined)
      .map(([o, l]) => `${l} ${usd(d.os[o]!)}`)
      .join(" · ");

  return (
    <div>
      <Toolbar>
        <Segmented label="OS" options={OSES.map(([id, l]) => [id, `${l} (${count(id)})`] as const)} value={os} onChange={setOs} />
        <Segmented
          label="A person can take over"
          options={[
            ["any", "Any"],
            ["yes", "Yes"],
          ]}
          value={takeover}
          onChange={setTakeover}
        />
      </Toolbar>
      <ResultTable
        cols={[
          { label: `${label} / hour` },
          { label: "Default size", left: true, className: "hidden md:table-cell" },
          { label: "Other systems", left: true, className: "hidden lg:table-cell" },
          { label: "Takeover", left: true, className: "hidden sm:table-cell" },
        ]}
      >
        {[...priced, ...planOnly].map((d, i) => {
          const v = d.os[os];
          return (
            <ResultRow key={d.id} rank={v === undefined ? 0 : i + 1} id={d.id} name={d.name} href={href(d)}>
              {v === undefined ? (
                <Txt className="text-right" title={`${d.name} ${label}: monthly plan only, no hourly price`}>
                  monthly plan only
                </Txt>
              ) : (
                <BarNum value={v} max={max} title={`${d.name} ${label}: ${usd(v)} per hour at list price`}>
                  {perHour(v)}
                </BarNum>
              )}
              <Txt className="hidden md:table-cell">{d.size}</Txt>
              <Txt className="hidden lg:table-cell">{others(d) || "—"}</Txt>
              <Txt className="hidden sm:table-cell">{d.takeover ? "yes" : "—"}</Txt>
            </ResultRow>
          );
        })}
      </ResultTable>
      {priced.length + planOnly.length === 0 ? <p className="mt-6 text-[14px] text-muted">No provider offers {label} with takeover yet.</p> : null}
      <Footnote>
        Cheapest first. <span className="font-mono">router.computer({`{ os: "${os}" }`})</span> starts one on the cheapest provider for that OS
        among those you have keys for. Takeover means a person can open a link to handle a login or CAPTCHA. Default sizes differ a lot, so
        compare both.
      </Footnote>
    </div>
  );
}
