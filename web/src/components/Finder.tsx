"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import published from "@/data/published.json";
import { recommend, type PublishedData, type PublishedLoad, type RecJob, type Recommendation } from "@/lib/recommend";
import { ProviderLogo, ProviderName } from "@/components/ProviderName";
import { ConditionalStartFeeNote } from "@/components/ConditionalStartFeeNote";
import { money } from "@/components/results";
import { site } from "@/lib/site";

const JOBS: [RecJob, string, string][] = [
  ["agent", "Agent session", "About a minute: 10 model turns, each a 6 s wait on the model and a short Python tool call. The sandbox is mostly idle."],
  ["python", "Quick Python run", "A 1 to 2 second pure-Python script (JSON, a regex and a sort over 200,000 records): one code-interpreter call."],
  ["repo", "Coding agent on a repo", "Fetch Node and a real TypeScript project, npm ci, typecheck: what a coding agent does first."],
  ["short", "Short CPU job", "One hash, then two concurrent hashes, then a 256 MB disk write."],
  ["long", "Long job", "The short job 40 times in a row: minutes of steady CPU and disk work."],
  ["download", "Download", "A 53 MB download over HTTPS."],
  ["start", "Start only", "Start a sandbox and run one command."],
];
const DATA = published as PublishedData;
const BATCH_JOBS: Partial<Record<RecJob, PublishedLoad["job"]>> = { start: "start", python: "rl", agent: "agents" };
const resultsFor = (job: RecJob) => (job === "start" ? DATA.start : DATA.jobs[job] ?? {});
const AVAILABLE_JOBS = JOBS.filter(([id]) => Object.keys(resultsFor(id)).length > 0);
const completeProviders = (batch: PublishedLoad, job: RecJob) =>
  Object.entries(batch.rows)
    .filter(([id, row]) => id in resultsFor(job) && row.ok === row.n && row.p50Ms !== undefined)
    .map(([id]) => id);
const HAS_PAIRED_STARTS = Object.values(DATA.start).every((row) => row.medianReadyMs !== undefined);
const shareButton = "border border-line px-3 py-1.5 text-[13px] text-ink-2 hover:border-line-2 hover:text-ink disabled:opacity-50";

const secs = (s: number) => (s >= 10 ? `${s.toFixed(0)} s` : `${s.toFixed(1)} s`);
const measuredSize = (size: Recommendation["size"]) =>
  size && (size.vcpu !== 2 || size.memoryGb !== 4) ? `${size.vcpu} vCPU / ${size.memoryGb} GB` : "";
const seg = (on: boolean) =>
  `px-3 py-1.5 text-[13px] border -ml-px first:ml-0 ${on ? "relative z-[1] border-accent bg-accent text-bg" : "border-line text-ink-2 hover:text-ink"}`;

type Point = Recommendation & {
  /** Cost the chart and list show: per 1,000 jobs per successful run, or per hour for "start". */
  y: number;
  frontier: boolean;
};

/**
 * Price against speed for one job: the answer first (cheapest, fastest, best value), then every provider on one
 * map where lower and further left is better, with a line through the ones nobody beats on both. The list below
 * is the same data as a table.
 */
export function Finder() {
  const [job, setJob] = useState<RecJob>(AVAILABLE_JOBS[0]?.[0] ?? "start");
  const [selectedCount, setCount] = useState(1);
  const [all, setAll] = useState(false);
  const [sharing, setSharing] = useState("");
  const [copyFallback, setCopyFallback] = useState(false);
  const [saving, setSaving] = useState(false);
  const chartRef = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const restoreSelection = () => {
      const query = new URLSearchParams(window.location.search);
      setJob(AVAILABLE_JOBS.find(([id]) => id === query.get("job"))?.[0] ?? AVAILABLE_JOBS[0]?.[0] ?? "start");
      setCount(Number(query.get("count")) || 1);
    };
    restoreSelection();
    window.addEventListener("popstate", restoreSelection);
    return () => window.removeEventListener("popstate", restoreSelection);
  }, []);

  const batches = DATA.load
    .filter((batch) => batch.job === BATCH_JOBS[job] && batch.n >= 10 && completeProviders(batch, job).length > 0)
    .sort((a, b) => a.n - b.n);
  const batch = batches.find((item) => item.n === selectedCount);
  const count = batch?.n ?? 1;

  const points: Point[] = useMemo(() => {
    const providers = batch && completeProviders(batch, job);
    const result = recommend(DATA, { job, count, providers, priority: "value" });
    const ps = result.results.map((x) => ({
      ...x,
      y: job === "start" ? (x.hourlyUsd ?? 0) : ((x.usdEach ?? 0) / Math.max(x.successRate, 0.01)) * 1000,
      frontier: false,
    }));
    // The best deals: nobody else is both faster and cheaper.
    let best = Infinity;
    for (const p of [...ps].sort((a, b) => a.secondsEach - b.secondsEach || a.y - b.y)) {
      if (p.y < best) {
        p.frontier = true;
        best = p.y;
      }
    }
    return ps;
  }, [batch, job, count]);

  const cheapest = [...points].sort((a, b) => a.y - b.y)[0];
  const fastest = [...points].sort((a, b) => a.secondsEach - b.secondsEach)[0];
  const value = points[0];
  if (!value) return null;
  const unit = job === "start" ? "per hour" : "per 1,000 jobs";
  // The table lists the cheapest first, so the price column reads in order; the best-value pick is in the tiles above.
  const byPrice = [...points].sort((a, b) => a.y - b.y || a.secondsEach - b.secondsEach);
  const shown = all ? byPrice : byPrice.slice(0, 8);
  const startLabel = batch || HAS_PAIRED_STARTS ? "to first command" : "to create response";
  const timeLabel = job === "start" ? startLabel : "per job";
  const [, jobLabel, description] = AVAILABLE_JOBS.find(([id]) => id === job) ?? JOBS[0];
  const chartLink = new URL("https://www.sandboxrouter.ai/benchmarks#find");
  chartLink.searchParams.set("job", job);
  if (count > 1) chartLink.searchParams.set("count", String(count));
  const boatFee = points.some((p) => p.provider === "boat") ? DATA.conditionalStartFees?.boat : undefined;
  const answers: [string, Point, string][] = [
    ["Cheapest", cheapest, `${money(cheapest.y)} ${unit}`],
    ["Fastest", fastest, `${secs(fastest.secondsEach)} ${timeLabel}`],
    [
      value === cheapest || value === fastest ? `Best value · also ${value === cheapest ? "cheapest" : "fastest"}` : "Best value",
      value,
      `${secs(value.secondsEach)} · ${money(value.y)} ${unit}`,
    ],
  ];

  const copyChart = async () => {
    try {
      await navigator.clipboard.writeText(chartLink.href);
      setSharing("Chart link copied.");
      setCopyFallback(false);
    } catch {
      setSharing("");
      setCopyFallback(true);
    }
  };

  const saveChart = async () => {
    const chart = chartRef.current;
    if (!chart) return;
    setSaving(true);
    setSharing("");
    try {
      const { downloadBenchmarkChart } = await import("@/lib/export-benchmark");
      const latest = points.map((p) => p.measuredAt).sort().at(-1) ?? DATA.dataThrough;
      const measuredThrough = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(latest));
      await downloadBenchmarkChart(chart, {
        jobLabel: count === 1 ? jobLabel : `${jobLabel} · ${count} at once`,
        description,
        measuredThrough,
        sourceUrl: chartLink.href,
        note: job === "start"
          ? "List prices for tested sandbox sizes."
          : `${points.length} providers plotted. Time includes startup. Cost per successful job is a retry estimate. The green line connects providers unbeaten on both axes. Sandbox sizes vary.`
            + (boatFee ? ` Boat's estimate excludes $${boatFee.minUsd.toFixed(2)}–$${boatFee.maxUsd.toFixed(2)} per start above allowance.` : ""),
        summaries: answers.map(([label, p, metric]) => ({ label, name: p.name, metric })),
      });
      setSharing("PNG download started.");
    } catch {
      setSharing("Couldn’t download the chart. Try again or copy its link.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section id="find" className="mt-10 scroll-mt-32 border border-line">
      <div className="border-b border-line p-5 sm:p-7">
        <h2 className="text-xl font-normal tracking-[-0.02em] sm:text-2xl">Find the best provider for your job</h2>
        <div className="mt-5 flex flex-wrap items-center gap-x-8 gap-y-3">
          <div className="flex flex-wrap" role="group" aria-label="What you're running">
            {AVAILABLE_JOBS.map(([id, label]) => (
              <button key={id} aria-pressed={job === id} onClick={() => setJob(id)} className={seg(job === id)}>
                {label}
              </button>
            ))}
          </div>
          {batches.length > 0 && <div className="flex items-center gap-3">
            <span className="text-[12px] text-muted">At once</span>
            <div className="flex" role="group" aria-label="How many at once">
              {[1, ...batches.map((item) => item.n)].map((n) => (
                <button key={n} aria-pressed={count === n} onClick={() => setCount(n)} className={seg(count === n)}>
                  {n}
                </button>
              ))}
            </div>
          </div>}
        </div>
        <p className="mt-4 text-[13px] text-muted">{description}</p>
        {batch && (
          <p className="mt-2 text-[13px] text-muted">
            {points.length} {points.length === 1 ? "provider" : "providers"} with single-run results completed a batch of {count}.{" "}
            <a href="#load" className="underline underline-offset-4 hover:text-ink">See all batch outcomes</a>.
          </p>
        )}
      </div>

      {/* The answer, before any chart. */}
      <div className="grid grid-cols-1 border-b border-line sm:grid-cols-3">
        {answers.map(([label, p, line], i) => (
          <div key={label} className={`p-5 sm:p-6 ${i ? "border-t border-line sm:border-t-0 sm:border-l" : ""}`}>
            <p className="text-[11px] uppercase tracking-[0.14em] text-muted">{label}</p>
            <p className="mt-2 flex items-center gap-2.5 text-[17px] text-ink">
              <ProviderLogo id={p.provider} name={p.name} size={22} />
              <span className="truncate">{p.name}</span>
            </p>
            <p className="mt-1.5 font-mono text-[13px] tnum text-ink-2">{line}</p>
            {measuredSize(p.size) && <p className="mt-1 text-[12px] text-muted">{measuredSize(p.size)}</p>}
          </div>
        ))}
      </div>

      <div className="p-5 sm:p-7">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <button type="button" className={shareButton} onClick={copyChart}>Copy chart link</button>
          <button type="button" className={shareButton} onClick={saveChart} disabled={saving}>
            {saving ? "Preparing image…" : "Download PNG"}
          </button>
          <span role="status" className="text-[12px] text-muted">{sharing}</span>
          {copyFallback && (
            <input
              aria-label="Chart link"
              className="w-full max-w-md border border-line px-2 py-1 text-[12px] text-ink-2"
              readOnly
              value={chartLink.href}
              onFocus={(e) => e.currentTarget.select()}
            />
          )}
        </div>
        <PriceSpeedMap svgRef={chartRef} points={points} unit={unit} count={count} startOnly={job === "start"} axisLabel={job === "start" ? `Time ${startLabel}` : "Time per job, incl. startup"} />
        <p className="mt-3 text-[12px] leading-5 text-muted">
          Lower and further left is better. The line joins the best deals: for each of them, no provider is both faster and cheaper.
          {batch && (job === "start"
            ? " Readiness comes from the batch. Hourly prices use the single-run configuration."
            : " Time combines batch readiness with the measured single-sandbox job time.")}
          {job === "start" ? "" : " Cost per successful run is a retry estimate, including modelled start and minimum charges."}
          {points.some((p) => measuredSize(p.size)) && " Sandbox sizes other than 2 vCPU / 4 GB are shown with their results."}
          {job !== "start" && boatFee && <> <ConditionalStartFeeNote id="boat" /></>}
        </p>

        <table className="mt-8 w-full text-[14px]">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-[0.12em] text-muted">
              <th className="w-8 py-2 pr-2 font-normal">#</th>
              <th className="py-2 pr-4 font-normal">Provider</th>
              <th className="py-2 pr-4 font-normal">{job === "start" ? "Median time" : "Time per job"}</th>
              <th className="py-2 pr-4 font-normal">{job === "start" ? "Per hour" : "Per 1,000 jobs"}</th>
              {count > 1 && job !== "start" ? <th className="hidden py-2 pr-4 font-normal sm:table-cell">For {count}</th> : null}
              <th className="hidden py-2 font-normal md:table-cell">Worth knowing</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((p, i) => (
              <tr key={p.provider} className="group border-t border-line">
                <td className="py-2.5 pr-2 font-mono text-[12px] text-muted">{i + 1}</td>
                <td className="py-2.5 pr-4">
                  <ProviderName id={p.provider} name={p.name}>
                    {p.frontier ? <span className="text-[11px] text-accent-ink">best deal</span> : null}
                  </ProviderName>
                  {measuredSize(p.size) && <p className="mt-0.5 pl-[28px] text-[12px] text-muted">{measuredSize(p.size)}</p>}
                </td>
                <td className="py-2.5 pr-4 font-mono tnum">{secs(p.secondsEach)}</td>
                <td className="py-2.5 pr-4 font-mono tnum">{money(p.y)}</td>
                {count > 1 && job !== "start" ? <td className="hidden py-2.5 pr-4 font-mono tnum sm:table-cell">{money((p.y / 1000) * count)}</td> : null}
                <td className="hidden py-2.5 text-[12px] text-muted md:table-cell">{p.notes.join(" · ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {points.length > 8 ? (
          <button type="button" aria-expanded={all} onClick={() => setAll((expanded) => !expanded)} className="mt-3 text-[13px] text-ink-2 underline underline-offset-4 decoration-line-2 hover:text-ink">
            {all ? "Show fewer" : `Show all ${points.length}`}
          </button>
        ) : null}
        <p className="mt-6 text-[12px] leading-5 text-muted">
          Cheapest first. The best-value pick combines cost and time, each compared with the median.{" "}
          <a href="/benchmarks.json" className="underline underline-offset-4 hover:text-ink">Current benchmark data</a>.
        </p>
      </div>
    </section>
  );
}

// ---- the map ----

/** Keep an endpoint and the decade ticks when the full log grid gets crowded. */
const niceTicks = (lo: number, hi: number) => {
  const out: number[] = [];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) {
    for (const k of [1, 2, 5]) {
      const v = k * 10 ** e;
      if (v >= lo && v <= hi) out.push(v);
    }
  }
  return out.length > 7 ? out.filter((v, i) => i === 0 || Math.abs(Math.log10(v) - Math.round(Math.log10(v))) < 1e-9) : out;
};

/** About five round ticks across a linear range. */
const linearTicks = (lo: number, hi: number) => {
  const raw = (hi - lo) / 5;
  const step = [1, 2, 5, 10].map((k) => k * 10 ** Math.floor(Math.log10(raw))).find((st) => st >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
};
/** Axis money, as short as it can be: $2, $0.5, $0.02. */
const tickMoney = (v: number) => `$${Number(v.toPrecision(1))}`;

const short = (name: string) => name.replace(/ (Sandboxes?|AI Agent Sandbox|Code Interpreter)$/, "").replace("Amazon Bedrock ", "").replace(/ \(.*\)$/, "");

function PriceSpeedMap({ svgRef, points, unit, count, startOnly, axisLabel }: { svgRef: RefObject<SVGSVGElement | null>; points: Point[]; unit: string; count: number; startOnly: boolean; axisLabel: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(720);
  const [hover, setHover] = useState<string | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const ps = points.filter((p) => p.y > 0 && p.secondsEach > 0);
  if (!ps.length) return null;
  const narrow = w < 560;
  const h = Math.max(280, Math.min(420, Math.round(w * 0.42)));
  const m = { l: 56, r: 16, t: 14, b: 44 };
  // Rounded, so the server and the browser draw exactly the same thing.
  const px = (n: number) => Math.round(n * 10) / 10;
  const xs = ps.map((p) => p.secondsEach).sort((a, b) => a - b);
  // One far-off provider would squeeze everyone else into a strip: cut the axis before it and pin it to the edge.
  const cut = xs.length > 3 && xs[xs.length - 1] > 1.6 * xs[xs.length - 2] ? xs[xs.length - 2] : undefined;
  const [xMin, xMax] = [xs[0], cut ?? xs[xs.length - 1]];
  // Times close together (an agent session is mostly the model's wait) read better on a linear axis.
  const xLog = xMax / xMin > 3;
  const [x0, x1] = xLog ? [xMin / 1.25, xMax * 1.25] : [Math.max(0, xMin - (xMax - xMin) * 0.12 - 0.5), xMax + (xMax - xMin) * 0.12 + 0.5];
  const [y0, y1] = [Math.min(...ps.map((p) => p.y)) / 1.5, Math.max(...ps.map((p) => p.y)) * 1.5];
  const X = (raw: number) => {
    const v = Math.min(raw, x1);
    return px(m.l + (xLog ? (Math.log10(v) - Math.log10(x0)) / (Math.log10(x1) - Math.log10(x0)) : (v - x0) / (x1 - x0)) * (w - m.l - m.r));
  };
  const Y = (v: number) => px(h - m.b - ((Math.log10(v) - Math.log10(y0)) / (Math.log10(y1) - Math.log10(y0))) * (h - m.t - m.b));
  const xt = xLog ? niceTicks(x0, x1) : linearTicks(x0, x1);
  const yt = niceTicks(y0, y1);
  const frontier = ps.filter((p) => p.frontier).sort((a, b) => a.secondsEach - b.secondsEach);

  // Names beside the best deals (right of the mark, or left near the edge), nudged apart so they don't overlap.
  const labels: { p: Point; y: number; left: boolean }[] = [];
  for (const p of [...frontier].sort((a, b) => Y(a.y) - Y(b.y))) {
    const prev = labels.at(-1);
    const y = Y(p.y);
    labels.push({ p, y: prev && y - prev.y < 15 ? prev.y + 15 : y, left: X(p.secondsEach) > w - m.r - 130 });
  }
  const hp = ps.find((p) => p.provider === hover);
  const S = 18;

  return (
    <div ref={box} className="relative">
      <svg ref={svgRef} width={w} height={h} role="img" aria-label={`Price against speed for ${ps.length} providers; the list below has the same data.`} className="block overflow-visible">
        {/* Grid and axes: hairline, recessive. */}
        {xt.map((v) => (
          <g key={`x${v}`}>
            <line x1={X(v)} x2={X(v)} y1={m.t} y2={h - m.b} stroke="var(--line)" />
            <text x={X(v)} y={h - m.b + 16} textAnchor="middle" className="fill-muted font-mono text-[11px]">
              {v >= 1 ? `${v} s` : `${Math.round(v * 1000)} ms`}
            </text>
          </g>
        ))}
        {yt.map((v) => (
          <g key={`y${v}`}>
            <line x1={m.l} x2={w - m.r} y1={Y(v)} y2={Y(v)} stroke="var(--line)" />
            <text x={m.l - 8} y={Y(v) + 4} textAnchor="end" className="fill-muted font-mono text-[11px]">
              {tickMoney(v)}
            </text>
          </g>
        ))}
        <text x={w - m.r} y={h - 6} textAnchor="end" className="fill-muted text-[11px]">
          {axisLabel}
          {xLog ? ", log scale" : ""} →
        </text>
        <text x={12} y={m.t} transform={`rotate(-90 12 ${m.t})`} textAnchor="end" className="fill-muted text-[11px]">
          Est. cost {unit}, log scale →
        </text>
        <text x={m.l + 8} y={h - m.b - 8} className="fill-accent-ink text-[11px]">
          ↙ better
        </text>

        {/* The best-deal line. */}
        {frontier.length > 1 ? (
          <polyline
            points={frontier.map((p) => `${X(p.secondsEach)},${Y(p.y)}`).join(" ")}
            fill="none"
            stroke="var(--chart)"
            strokeWidth={2}
            strokeLinejoin="round"
          />
        ) : null}

        {/* Provider logos, with a stronger mark for each point on the price/speed frontier. */}
        {[...ps]
          .sort((a, b) => Number(a.frontier) - Number(b.frontier))
          .map((p) => {
            const cx = X(p.secondsEach);
            const cy = Y(p.y);
            const logo = site.logos[p.provider];
            return (
              <g
                key={p.provider}
                opacity={hover === p.provider || p.frontier ? 1 : 0.55}
                onMouseEnter={() => setHover(p.provider)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(p.provider)}
                onBlur={() => setHover(null)}
                tabIndex={0}
                aria-label={[`${p.name}: ${secs(p.secondsEach)}, ${money(p.y)} ${unit}`, measuredSize(p.size)].filter(Boolean).join(", ")}
                className="outline-none"
              >
                <rect x={cx - 16} y={cy - 16} width={32} height={32} fill="transparent" />
                {/* A ring in the surface color keeps overlapping marks apart; best deals get the chart color. */}
                <rect x={cx - S / 2 - 2} y={cy - S / 2 - 2} width={S + 4} height={S + 4} fill={p.frontier ? "var(--chart)" : "var(--bg)"} />
                <rect x={cx - S / 2} y={cy - S / 2} width={S} height={S} fill="#fff" stroke="var(--line-2)" />
                {logo ? (
                  <image href={logo} x={cx - S / 2 + 2} y={cy - S / 2 + 2} width={S - 4} height={S - 4} preserveAspectRatio="xMidYMid meet" />
                ) : (
                  <text x={cx} y={cy + 4} textAnchor="middle" className="text-[10px]" fill="#555">
                    {p.name.charAt(0)}
                  </text>
                )}
              </g>
            );
          })}
        {cut !== undefined
          ? ps
              .filter((p) => p.secondsEach > x1)
              .map((p) => (
                <text key={`cut${p.provider}`} x={X(p.secondsEach)} y={Y(p.y) + 24} textAnchor="middle" className="fill-muted font-mono text-[11px]">
                  {secs(p.secondsEach)} →
                </text>
              ))
          : null}
        {/* Names on top of the marks, with a surface-colored halo so they stay readable over grid and marks. */}
        {!narrow
          ? labels.map(({ p, y, left }) => (
              <text
                key={`l${p.provider}`}
                x={X(p.secondsEach) + (left ? -(S / 2 + 8) : S / 2 + 8)}
                y={y + 4}
                textAnchor={left ? "end" : "start"}
                stroke="var(--bg)"
                strokeWidth={3}
                paintOrder="stroke"
                className="fill-ink-2 text-[12px]"
              >
                {short(p.name)}
              </text>
            ))
          : null}
      </svg>

      {hp ? (
        <div
          className="pointer-events-none absolute z-10 w-60 border border-line bg-bg p-3 text-[12px] shadow-sm"
          style={{ left: Math.max(0, Math.min(X(hp.secondsEach) + 18, w - 244)), top: Math.max(0, Y(hp.y) - 24) }}
        >
          <p className="flex items-center gap-2 text-[13px] text-ink">
            <ProviderLogo id={hp.provider} name={hp.name} size={16} />
            {hp.name}
          </p>
          <p className="mt-2 font-mono tnum text-ink-2">
            {secs(hp.secondsEach)} · {money(hp.y)} {unit}
          </p>
          {count > 1 && !startOnly ? (
            <p className="font-mono tnum text-ink-2">
              {money(hp.usdTotal)} for {count}
            </p>
          ) : null}
          <p className="mt-1 text-muted">
            {Math.round(hp.successRate * 100)}% of runs worked · {hp.runs} runs
          </p>
          {measuredSize(hp.size) && <p className="mt-1 text-muted">{measuredSize(hp.size)}</p>}
          {hp.notes.length ? <p className="mt-1 text-muted">{hp.notes.join(" · ")}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
