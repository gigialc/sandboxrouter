"use client";

import { useState } from "react";
import { ProviderName } from "@/components/ProviderName";
import { site, usd } from "@/lib/site";

const OSES = [
  ["linux", "Linux"],
  ["windows", "Windows"],
  ["android", "Android"],
  ["ios", "iOS"],
] as const;
type Os = (typeof OSES)[number][0];

/**
 * Desktops and phones, laid out like the sandbox table: pick an OS, see who offers it cheapest first with a price
 * bar, and filter to the ones a person can take over. The router picks the cheapest for the OS you ask for.
 */
export function DesktopTable() {
  const [os, setOs] = useState<Os>("linux");
  const [takeover, setTakeover] = useState(false);
  const label = OSES.find(([id]) => id === os)![1];
  const priced = site.desktops.filter((d) => d.os[os] !== undefined && (!takeover || d.takeover)).sort((a, b) => a.os[os]! - b.os[os]!);
  const planOnly = site.desktops.filter((d) => d.os[os] === undefined && d.planOnly?.includes(os) && (!takeover || d.takeover));
  const max = Math.max(0.0001, ...priced.map((d) => d.os[os]!));
  const count = (o: Os) => site.desktops.filter((d) => d.os[o] !== undefined || d.planOnly?.includes(o)).length;
  const chip = (on: boolean) => `rounded-full px-2.5 py-1 text-[12px] tnum ${on ? "bg-accent text-bg" : "text-ink-2 hover:bg-accent-soft hover:text-ink"}`;
  // Desktop-only providers have no sandbox page; their name links to their docs.
  const href = (d: (typeof site.desktops)[number]) => (site.providers.some((p) => p.id === d.id) ? `/providers/${d.id}` : d.docs);
  const others = (d: (typeof site.desktops)[number]) =>
    OSES.filter(([o]) => o !== os && d.os[o] !== undefined)
      .map(([o, l]) => `${l} ${usd(d.os[o]!)}`)
      .join(" · ");

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-y border-line py-3 text-[12px]">
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-2 text-muted">OS</span>
          {OSES.map(([id, l]) => (
            <button key={id} aria-pressed={os === id} onClick={() => setOs(id)} className={chip(os === id)}>
              {l} ({count(id)})
            </button>
          ))}
        </div>
        <button aria-pressed={takeover} onClick={() => setTakeover(!takeover)} className={`${chip(takeover)} sm:ml-auto`}>
          A person can take over
        </button>
      </div>

      <table className="w-full text-[14px]">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-[0.12em] text-muted">
            <th className="py-3 pr-4 font-normal">Provider</th>
            <th className="py-3 pr-4 font-normal">{label} / hr</th>
            <th className="hidden py-3 pr-4 font-normal md:table-cell">Default size</th>
            <th className="hidden py-3 pr-4 font-normal lg:table-cell">Other systems</th>
            <th className="hidden py-3 font-normal sm:table-cell">Takeover</th>
          </tr>
        </thead>
        <tbody>
          {[...priced, ...planOnly].map((d) => {
            const v = d.os[os];
            return (
              <tr key={d.id} className="group border-t border-line">
                <td className="py-3 pr-4">
                  <ProviderName id={d.id} name={d.name} href={href(d)} />
                </td>
                <td className="py-3 pr-4">
                  {v === undefined ? (
                    <span className="text-ink-2" title={`${d.name} ${label}: monthly plan only, no hourly price`}>
                      monthly plan only
                    </span>
                  ) : (
                    <div className="flex items-center gap-3" title={`${d.name} ${label}: ${usd(v)} per hour at list price`}>
                      <span className="w-20 font-mono tnum text-ink">{usd(v)}</span>
                      <span className="hidden h-px w-28 bg-line sm:block">
                        <span className="block h-px bg-bar" style={{ width: `${Math.max(1.5, (v / max) * 100)}%` }} />
                      </span>
                    </div>
                  )}
                </td>
                <td className="hidden py-3 pr-4 text-ink-2 md:table-cell">{d.size}</td>
                <td className="hidden py-3 pr-4 font-mono text-[12px] tnum text-ink-2 lg:table-cell">{others(d) || "—"}</td>
                <td className="hidden py-3 text-ink-2 sm:table-cell">{d.takeover ? "yes" : "—"}</td>
              </tr>
            );
          })}
          {priced.length + planOnly.length === 0 && (
            <tr className="border-t border-line">
              <td colSpan={5} className="py-8 text-center text-muted">
                No provider offers {label} with takeover yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="mt-4 max-w-4xl text-[13px] leading-6 text-ink-2">
        Cheapest first. <span className="font-mono">router.computer({`{ os: "${os}" }`})</span> starts one on the cheapest provider for that
        OS among those you have keys for. Takeover means a person can open a link to handle a login or CAPTCHA. Default sizes differ a lot,
        so compare both.
      </p>
    </div>
  );
}
