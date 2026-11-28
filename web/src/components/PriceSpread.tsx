"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { site } from "@/lib/site";

const usd = (n: number) => `$${n.toFixed(n < 0.1 ? 4 : 3)}`;
const TICKS = [0.005, 0.01, 0.02, 0.05, 0.1, 0.2];
const LO = Math.log(0.0025);
const HI = Math.log(0.25);
const R = 5;
const STEP = 2 * R + 2;
const PAD = 14;
const TOP = 26;

/**
 * The price of sandbox compute today: every hosted provider's list price per vCPU-hour as a dot on a
 * logarithmic axis, with the median marked. Dots that would overlap stack upwards.
 */
export function PriceSpread() {
  const { rows, medianVcpuHourUsd: median, size } = site.priceSpread;
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setWidth(Math.max(280, Math.round(el.clientWidth)));
    fit();
    const watch = new ResizeObserver(fit);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  const x = (v: number) => PAD + ((Math.log(v) - LO) / (HI - LO)) * (width - 2 * PAD);
  const { dots, levels } = useMemo(() => {
    const last: number[] = [];
    const placed = rows.map((r) => {
      const cx = PAD + ((Math.log(r.vcpuHourUsd) - LO) / (HI - LO)) * (width - 2 * PAD);
      let level = last.findIndex((at) => cx - at >= STEP);
      if (level === -1) level = last.length;
      last[level] = cx;
      return { ...r, cx, level };
    });
    return { dots: placed, levels: Math.max(1, last.length) };
  }, [rows, width]);

  if (!rows.length) return null;
  const base = TOP + levels * STEP;
  const height = base + 30;
  const cheapest = rows[0];
  const dearest = rows[rows.length - 1];
  const hovered = dots.find((d) => d.provider === active);
  const mx = x(median);

  return (
    <div>
      <div className="text-[11px] uppercase tracking-[0.12em] text-muted">Price of sandbox compute</div>
      <div className="mt-2 flex flex-wrap items-end gap-x-10 gap-y-3">
        <div>
          <span className="font-mono text-[40px] leading-none tnum text-ink">{usd(median)}</span>
          <span className="ml-2 text-[14px] text-muted">per vCPU-hour, median</span>
        </div>
        <dl className="flex flex-wrap gap-x-8 gap-y-2 text-[13px]">
          <div>
            <dt className="text-[11px] text-muted">Cheapest</dt>
            <dd className="text-ink">
              <span className="font-mono tnum">{usd(cheapest.vcpuHourUsd)}</span>{" "}
              <Link href={`/providers/${cheapest.provider}`} className="text-muted underline-offset-4 hover:underline">{cheapest.name}</Link>
            </dd>
          </div>
          <div>
            <dt className="text-[11px] text-muted">Most expensive</dt>
            <dd className="text-ink">
              <span className="font-mono tnum">{usd(dearest.vcpuHourUsd)}</span>{" "}
              <Link href={`/providers/${dearest.provider}`} className="text-muted underline-offset-4 hover:underline">{dearest.name}</Link>
            </dd>
          </div>
          <div>
            <dt className="text-[11px] text-muted">Spread</dt>
            <dd className="font-mono tnum text-ink">{Math.round(dearest.vcpuHourUsd / cheapest.vcpuHourUsd)}×</dd>
          </div>
        </dl>
      </div>

      <div ref={box} className="relative mt-6" onMouseLeave={() => setActive(null)}>
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`List price per vCPU-hour of ${rows.length} sandbox providers, from ${usd(cheapest.vcpuHourUsd)} to ${usd(dearest.vcpuHourUsd)}; the median is ${usd(median)}`}
          className="block"
        >
          {TICKS.map((t) => (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={TOP} y2={base + 6} className="stroke-line" strokeWidth="1" />
              <text x={x(t)} y={base + 22} textAnchor="middle" className="fill-muted font-mono text-[10px]">${t}</text>
            </g>
          ))}
          <line x1={PAD} x2={width - PAD} y1={base + 6} y2={base + 6} className="stroke-line-2" strokeWidth="1" />
          <line x1={mx} x2={mx} y1={14} y2={base + 6} className="stroke-ink" strokeWidth="1" strokeDasharray="3 3" />
          <text x={mx - 6} y={12} textAnchor="end" className="fill-ink text-[11px]">Median {usd(median)}</text>
          {dots.map((d) => (
            <a key={d.provider} href={`/providers/${d.provider}`} aria-label={`${d.name}: ${usd(d.vcpuHourUsd)} per vCPU-hour`} onFocus={() => setActive(d.provider)} onBlur={() => setActive(null)}>
              {/* A hit area larger than the dot. */}
              <circle cx={d.cx} cy={base - R - d.level * STEP} r={R + 1} fill="transparent" onMouseEnter={() => setActive(d.provider)} />
              <circle
                cx={d.cx}
                cy={base - R - d.level * STEP}
                r={d.provider === active ? R + 1.5 : R}
                className={`pointer-events-none fill-accent ${active && d.provider !== active ? "opacity-40" : ""}`}
                stroke="var(--bg)"
                strokeWidth="1.5"
              />
            </a>
          ))}
        </svg>
        {hovered && (
          <div
            className="pointer-events-none absolute z-10 w-max max-w-[240px] -translate-y-full rounded-md border border-line bg-panel px-3 py-2 text-[12px] shadow-sm"
            style={{ left: Math.min(Math.max(hovered.cx - 90, 0), Math.max(0, width - 200)), top: base - R - hovered.level * STEP - 12 }}
          >
            <div className="text-ink">{hovered.name}</div>
            <div className="mt-0.5 font-mono tnum text-ink">
              {usd(hovered.vcpuHourUsd)} <span className="text-muted">per vCPU-hour</span>
            </div>
            <div className="font-mono tnum text-muted">
              {usd(hovered.hourlyUsd)}/h at {size.vcpu} vCPU / {size.memoryGb} GB
            </div>
            {!hovered.tested && <div className="mt-0.5 text-muted">Not run on our account yet</div>}
          </div>
        )}
      </div>

      <p className="mt-3 max-w-3xl text-[11px] leading-5 text-muted">
        Each dot is one of {rows.length} providers: its list price for a {size.vcpu} vCPU / {size.memoryGb} GB sandbox running for an hour with
        every core busy, divided by {size.vcpu}. The axis is logarithmic, so equal distances are equal ratios. Providers that bill CPU only while
        it is busy cost less than this when a sandbox waits. These are published prices, not what a job costs: a cheaper hour on a slower machine
        can cost more per job, which the{" "}
        <Link href="/benchmarks" className="underline underline-offset-2">benchmarks</Link> measure. Prices are recorded each time one changes
        {site.priceHistory[0] ? `, since ${site.priceHistory[0].date}` : ""}.{" "}
        <Link href="/methodology#spread" className="underline underline-offset-2">How it&apos;s made</Link>
      </p>
    </div>
  );
}
