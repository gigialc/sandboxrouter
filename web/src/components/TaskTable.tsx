import Link from "next/link";
import { site } from "@/lib/site";

/** Enough digits to tell cheap tasks apart. */
const money = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(4)}`);
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const perHour = (n: number) => `$${n >= 1 ? n.toFixed(2) : n >= 0.01 ? n.toFixed(3) : n.toFixed(4)}/h`;

/** Measured cost of the standard task (src/task.ts) on each provider, cheapest first. Same look as the providers table. */
export function TaskTable() {
  const { rows, phases } = site.tasks;
  if (!rows.length) return null;
  const maxTask = Math.max(...rows.map((r) => r.taskMs), 1);

  return (
    <table className="mt-6 w-full text-[14px]">
      <thead>
        <tr className="text-left text-[11px] uppercase tracking-[0.12em] text-muted">
          <th className="w-10 py-3 pr-2 font-normal">#</th>
          <th className="py-3 pr-4 font-normal">Provider</th>
          <th className="py-3 pr-4 font-normal">Task took</th>
          <th className="py-3 pr-4 font-normal">1,000 tasks cost</th>
          <th className="hidden py-3 font-normal sm:table-cell">Per hour</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const notes = [
            r.size.vcpu !== 2 || r.size.memoryGb !== 4 ? `${r.size.vcpu} vCPU / ${r.size.memoryGb} GB` : "",
            r.minimumSeconds > 1 ? `bills at least ${r.minimumSeconds} s` : "",
            r.perSandboxUsd ? `+$${Number(r.perSandboxUsd.toPrecision(2))} per sandbox` : "",
          ].filter(Boolean);
          const split = phases.map((p) => `${p.label} ${secs(r.phasesMs[p.id])}`).join(", ");
          return (
            <tr key={r.provider} className="group border-t border-line">
              <td className="py-3 pr-2 font-mono text-[12px] text-muted">{i + 1}</td>
              <td className="py-3 pr-4">
                <Link href={`/providers/${r.provider}`} className="text-ink group-hover:underline underline-offset-4 decoration-line-2">
                  {r.name}
                </Link>
                {notes.length ? <span className="ml-2 text-[11px] text-muted">{notes.join(", ")}</span> : null}
              </td>
              <td className="py-3 pr-4">
                <div className="flex items-center gap-3" title={`${split}; started in ${secs(r.createMs)}`}>
                  <span className="w-14 font-mono tnum text-ink">{secs(r.taskMs)}</span>
                  <span className="hidden h-px w-28 bg-line sm:block">
                    <span className="block h-px bg-bar" style={{ width: `${(r.taskMs / maxTask) * 100}%` }} />
                  </span>
                </div>
              </td>
              <td className="py-3 pr-4 font-mono tnum text-ink">{money(r.taskUsd * 1000)}</td>
              <td className="hidden py-3 font-mono tnum text-ink-2 sm:table-cell">{perHour(r.hourlyUsd)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
