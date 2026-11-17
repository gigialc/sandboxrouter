import Link from "next/link";
import { ProviderName } from "@/components/ProviderName";
import { site } from "@/lib/site";

const secs = (ms?: number) => (ms === undefined ? "n/a" : `${(ms / 1000).toFixed(1)} s`);
const money = (n?: number) => (n === undefined ? "n/a" : n >= 1 ? `$${n.toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(4)}`);

/** A real model doing the same task in a sandbox on each provider: done right first, then cheapest per session. */
export function AgentTable() {
  const rows = site.agent;
  if (!rows.length) return null;
  return (
    <div className="mt-6">
      <table className="w-full text-[14px]">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-[0.12em] text-muted">
            <th className="py-3 pr-4 font-normal">Provider</th>
            <th className="py-3 pr-4 font-normal">Done right</th>
            <th className="hidden py-3 pr-4 font-normal sm:table-cell">Session</th>
            <th className="hidden py-3 pr-4 font-normal md:table-cell">Sandbox idle</th>
            <th className="py-3 font-normal">1,000 sessions cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const idle = r.medianWallMs && r.medianModelMs ? Math.round((r.medianModelMs / r.medianWallMs) * 100) : undefined;
            return (
              <tr key={r.provider} className="group border-t border-line">
                <td className="py-3 pr-4">
                  <ProviderName id={r.provider} name={r.name} />
                </td>
                <td className="py-3 pr-4 font-mono tnum text-ink">
                  {r.ok}/{r.runs}
                  {r.limited ? <span className="ml-2 font-sans text-[11px] text-muted">{r.limited} over our account&apos;s limit</span> : null}
                </td>
                <td className="hidden py-3 pr-4 font-mono tnum text-ink-2 sm:table-cell" title={`${r.medianTurns ?? "?"} turns`}>
                  {secs(r.medianWallMs)}
                </td>
                <td className="hidden py-3 pr-4 font-mono tnum text-ink-2 md:table-cell">{idle === undefined ? "n/a" : `${idle}%`}</td>
                <td className="py-3 font-mono tnum text-ink">{money(r.medianUsd === undefined ? undefined : r.medianUsd * 1000)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-3 text-[12px] text-muted">
        {rows[0].model}, the same task each time; the sandbox&apos;s cost only, not the model&apos;s. Idle is the share of the session spent waiting on the model.
      </p>
    </div>
  );
}
