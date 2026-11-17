// One look for every results table on the site: a toolbar of square segmented controls, then a table at a
// readable width with the provider (logo, name, notes under it) and right-aligned numbers, the main one with a bar.
import { ProviderName } from "@/components/ProviderName";

// ---- formatting ----

/** Money with enough digits to compare, never "$0.0000": two significant digits under a cent. */
export const money = (n?: number) =>
  n === undefined || !Number.isFinite(n)
    ? "n/a"
    : n >= 100
      ? `$${n.toFixed(0)}`
      : n >= 1
        ? `$${n.toFixed(2)}`
        : n >= 0.01
          ? `$${n.toFixed(3)}`
          : n === 0
            ? "$0"
            : `$${Number(n.toPrecision(2)).toFixed(Math.max(2, 1 - Math.floor(Math.log10(n))))}`;
export const perHour = (n?: number) => (n === undefined ? "n/a" : `${money(n)}/h`);
/** Milliseconds as "320 ms", "4.2 s", "31 s" or "3.4 min". */
export const time = (ms?: number) =>
  ms === undefined
    ? "n/a"
    : ms < 1000
      ? `${Math.round(ms)} ms`
      : ms < 10_000
        ? `${(ms / 1000).toFixed(1)} s`
        : ms < 120_000
          ? `${Math.round(ms / 1000)} s`
          : `${(ms / 60_000).toFixed(1)} min`;

// ---- controls ----

const seg = (on: boolean) =>
  `-ml-px first:ml-0 border px-3 py-1.5 text-[13px] whitespace-nowrap ${
    on ? "relative z-[1] border-accent bg-accent text-bg" : "border-line text-ink-2 hover:text-ink"
  }`;

/** A labelled group of square buttons, one of which is on. */
export function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label?: string;
  options: readonly (readonly [T, string])[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {label ? <span className="text-[12px] text-muted">{label}</span> : null}
      <div className="flex flex-wrap" role="group" aria-label={label}>
        {options.map(([v, l]) => (
          <button key={String(v)} aria-pressed={v === value} onClick={() => onChange(v)} className={seg(v === value)}>
            {l}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The row of controls above a table, and one muted line under it saying exactly what's measured. */
export function Toolbar({ children, note }: { children: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-3">{children}</div>
      {note ? <p className="mt-3 max-w-3xl text-[13px] leading-5 text-muted">{note}</p> : null}
    </div>
  );
}

// ---- table ----

export type Col = { label: string; className?: string };
const hide = (c?: string) => c ?? "";

/** The table frame: readable width, hairline rows, uppercase muted headers, numbers right-aligned. */
export function ResultTable({ cols, children, ranked = true }: { cols: Col[]; children: React.ReactNode; ranked?: boolean }) {
  return (
    <div className="mt-5 max-w-5xl">
      <table className="w-full text-[14px]">
        <thead>
          <tr className="border-b border-line text-[11px] uppercase tracking-[0.12em] text-muted">
            {ranked ? <th className="w-9 py-2.5 pr-2 text-left font-normal">#</th> : null}
            <th className="py-2.5 pr-4 text-left font-normal">Provider</th>
            {cols.map((c) => (
              <th key={c.label} className={`py-2.5 pl-4 text-right font-normal ${hide(c.className)}`}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** A provider row: rank, logo and name with any notes under it, then its numbers. */
export function ResultRow({
  rank,
  id,
  name,
  notes,
  href,
  dim,
  children,
}: {
  rank?: number;
  id: string;
  name: string;
  notes?: string[];
  href?: string;
  dim?: boolean;
  children: React.ReactNode;
}) {
  return (
    <tr className={`group border-b border-line ${dim ? "text-muted" : ""}`}>
      {rank !== undefined ? <td className="py-3 pr-2 align-top font-mono text-[12px] text-muted">{rank || ""}</td> : null}
      <td className="py-3 pr-4 align-top">
        <ProviderName id={id} name={name} href={href} />
        {notes?.length ? <p className="mt-0.5 pl-[28px] text-[12px] text-muted">{notes.join(" · ")}</p> : null}
      </td>
      {children}
    </tr>
  );
}

/** A right-aligned number cell. `strong` for the column the table is ranked by. */
export function Num({ children, strong, className, title }: { children: React.ReactNode; strong?: boolean; className?: string; title?: string }) {
  return (
    <td title={title} className={`py-3 pl-4 text-right align-top font-mono tnum whitespace-nowrap ${strong ? "text-ink" : "text-ink-2"} ${hide(className)}`}>
      {children}
    </td>
  );
}

/** The ranked-by number with a bar to its left, so the column reads at a glance. */
export function BarNum({ value, max, children, className, title }: { value: number; max: number; children: React.ReactNode; className?: string; title?: string }) {
  const pct = max > 0 ? Math.max(2, Math.min(100, (value / max) * 100)) : 0;
  return (
    <td title={title} className={`py-3 pl-4 align-top ${hide(className)}`}>
      <div className="flex items-center justify-end gap-3">
        <span className="hidden h-[3px] w-20 bg-line sm:block" aria-hidden>
          <span className="block h-[3px] bg-bar" style={{ width: `${pct}%` }} />
        </span>
        <span className="font-mono tnum whitespace-nowrap text-ink">{children}</span>
      </div>
    </td>
  );
}

/** A short line under a table. */
export function Footnote({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 max-w-3xl text-[12px] leading-5 text-muted">{children}</p>;
}

/** The bar scale for a column: its largest value, capped at four times the median so one outlier can't flatten every bar. */
export function barMax(values: number[]) {
  const v = values.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!v.length) return 1;
  const mid = v[Math.floor(v.length / 2)];
  return Math.min(v[v.length - 1], mid * 4);
}
