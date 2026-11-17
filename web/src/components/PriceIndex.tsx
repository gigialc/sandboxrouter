import Link from "next/link";
import { site } from "@/lib/site";

const money = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(4)}`);
const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** A thin line through the median's recorded values: only drawn once there are two of them. */
function Spark({ values, dark }: { values: number[]; dark: boolean }) {
  if (values.length < 2) return null;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 64},${hi === lo ? 8 : 15 - ((v - lo) / (hi - lo)) * 14}`).join(" ");
  return (
    <svg width="64" height="16" viewBox="0 0 64 16" aria-hidden="true" className="hidden sm:block">
      <polyline points={pts} fill="none" strokeWidth="1.25" className={dark ? "stroke-[#2fbf7f]" : "stroke-accent"} />
    </svg>
  );
}

/**
 * The price index: what standard pieces of sandbox work cost today across tested providers (the median), the
 * cheapest, and the change since the index was last recorded. `dark` for the homepage's dark panel.
 */
export function PriceIndex({ dark = false }: { dark?: boolean }) {
  const { lines, history } = site.priceIndex;
  if (!lines.length) return null;
  const first = history[0]?.date;
  const prev = history.length >= 2 ? history[history.length - 2] : undefined;
  const ink = dark ? "text-white" : "text-ink";
  const muted = dark ? "text-white/55" : "text-muted";
  const line = dark ? "border-white/10" : "border-line";

  return (
    <div>
      <div className={`grid grid-cols-[1fr_auto] gap-x-6 pb-2 text-[11px] uppercase tracking-[0.12em] sm:grid-cols-[1fr_auto_auto_auto] ${muted}`}>
        <span>Price index</span>
        <span className="text-right">Median</span>
        <span className="hidden text-right sm:block">Cheapest</span>
        <span className="hidden sm:block" />
      </div>
      {lines.map((l) => {
        const before = prev?.lines[l.id]?.median;
        const change = before ? (l.median - before) / before : undefined;
        const values = history.map((h) => h.lines[l.id]?.median).filter((v): v is number => typeof v === "number");
        return (
          <div key={l.id} className={`grid grid-cols-[1fr_auto] items-center gap-x-6 border-t py-3 sm:grid-cols-[1fr_auto_auto_auto] ${line}`}>
            <div>
              <div className={`text-[14px] ${ink}`}>{l.label}</div>
              <div className={`text-[11px] ${muted}`}>
                {l.unit} · {l.providers} tested providers
              </div>
            </div>
            <div className="text-right">
              <div className={`font-mono text-[18px] tnum ${ink}`}>{money(l.median)}</div>
              {change !== undefined && Math.abs(change) >= 0.0005 ? (
                <div className={`font-mono text-[11px] tnum ${muted}`}>
                  {change < 0 ? "▼" : "▲"} {Math.abs(change * 100).toFixed(1)}%
                </div>
              ) : null}
            </div>
            <div className="hidden text-right sm:block">
              <Link href={`/providers/${l.cheapest.provider}`} className={`text-[13px] hover:underline underline-offset-4 ${ink}`}>
                {l.cheapest.name}
              </Link>
              <div className={`font-mono text-[11px] tnum ${muted}`}>{money(l.cheapest.usd)}</div>
            </div>
            <div className="hidden sm:block">
              <Spark values={values} dark={dark} />
            </div>
          </div>
        );
      })}
      <p className={`mt-3 text-[11px] leading-5 ${muted}`}>
        Median across providers that passed our real-account check, priced for the whole run{first ? `; recorded since ${day(first)}` : ""}.{" "}
        <Link href="/methodology#index" className="underline underline-offset-2">
          How it&apos;s made
        </Link>
      </p>
    </div>
  );
}
