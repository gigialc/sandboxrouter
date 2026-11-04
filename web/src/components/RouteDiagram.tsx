"use client";

import { useEffect, useState } from "react";

type Row = { id: string; name: string; price: string };
type Mark = { state: "win" | "fail" | "dim" | "idle"; note?: string };
type Scene = { chip: string; caption: string; marks: Record<string, Mark> };

const ROWS: Row[] = [
  { id: "maritime", name: "Maritime", price: "$0.022/hr" },
  { id: "morph", name: "Morph Cloud", price: "$0.100/hr" },
  { id: "e2b", name: "E2B", price: "$0.166/hr" },
  { id: "daytona", name: "Daytona", price: "$0.166/hr" },
  { id: "modal", name: "Modal", price: "$0.239/hr" },
  { id: "vercel", name: "Vercel Sandbox", price: "$0.341/hr" },
];

const SCENES: Scene[] = [
  {
    chip: `strategy: "cheapest"`,
    caption: "Picks the cheapest provider that fits",
    marks: { maritime: { state: "win" } },
  },
  {
    chip: `gpu: "A10G"`,
    caption: "Only providers that can do the job are tried",
    marks: Object.fromEntries(
      ROWS.map((r) => [r.id, r.id === "modal" ? { state: "win" } : { state: "dim", note: "no gpu" }]),
    ) as Record<string, Mark>,
  },
  {
    chip: "fallback",
    caption: "Busy? The next provider takes it",
    marks: { maritime: { state: "fail", note: "429" }, morph: { state: "fail", note: "503" }, e2b: { state: "win" } },
  },
];

const ROW_H = 46;
const GAP = 8;

export function RouteDiagram() {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => setI((n) => (n + 1) % SCENES.length), 3200);
    return () => clearInterval(t);
  }, []);
  const scene = SCENES[i];
  const total = ROWS.length * ROW_H + (ROWS.length - 1) * GAP;
  const mid = total / 2;

  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-card p-4 sm:p-6">
      <div className="mb-5 flex flex-wrap items-center gap-2">
        {SCENES.map((s, j) => (
          <button
            key={s.chip}
            onClick={() => setI(j)}
            className={`rounded-full border px-3 py-1 font-mono text-xs transition ${
              j === i ? "border-ink bg-ink text-sand" : "border-line text-muted hover:text-ink"
            }`}
          >
            {s.chip}
          </button>
        ))}
      </div>

      <div className="flex items-center" style={{ height: total }}>
        <div className="hidden shrink-0 rounded-xl border border-line bg-sand px-3 py-2 text-center sm:block">
          <div className="font-mono text-[11px] text-muted">your agent</div>
          <div className="font-mono text-sm">create()</div>
        </div>
        <svg className="hidden h-full w-10 shrink-0 sm:block" viewBox={`0 0 40 ${total}`} preserveAspectRatio="none" aria-hidden="true">
          <path d={`M0 ${mid} H40`} stroke="var(--accent)" strokeWidth="2" className="sr-flow" />
        </svg>
        <div className="shrink-0 rounded-xl bg-ink px-2.5 py-2 text-center text-sand sm:px-3">
          <div className="font-mono text-[11px] opacity-70">router</div>
          <div className="font-mono text-xs sm:text-sm">sandboxrouter</div>
        </div>
        <svg className="h-full min-w-6 flex-1" viewBox={`0 0 100 ${total}`} preserveAspectRatio="none" aria-hidden="true">
          {ROWS.map((r, k) => {
            const y = k * (ROW_H + GAP) + ROW_H / 2;
            const m = scene.marks[r.id]?.state ?? "idle";
            const color = m === "win" ? "var(--accent)" : m === "fail" ? "var(--bad)" : "var(--line-2)";
            return (
              <path
                key={r.id}
                d={`M0 ${mid} C50 ${mid}, 50 ${y}, 100 ${y}`}
                stroke={color}
                strokeWidth={m === "win" ? 2.5 : 1.5}
                fill="none"
                vectorEffect="non-scaling-stroke"
                className={m === "win" ? "sr-flow" : ""}
                opacity={m === "dim" ? 0.35 : 1}
              />
            );
          })}
        </svg>
        <ul className="w-40 shrink-0 space-y-2 sm:w-56">
          {ROWS.map((r) => {
            const m = scene.marks[r.id] ?? { state: "idle" as const };
            return (
              <li
                key={r.id}
                style={{ height: ROW_H }}
                className={`flex items-center justify-between rounded-lg border px-2.5 text-xs transition-all duration-300 sm:px-3 sm:text-sm ${
                  m.state === "win"
                    ? "border-accent bg-accent-wash"
                    : m.state === "fail"
                      ? "border-bad/40"
                      : "border-line"
                } ${m.state === "dim" ? "opacity-40" : ""}`}
              >
                <span className="truncate font-medium">{r.name}</span>
                <span className="ml-2 shrink-0 font-mono text-xs">
                  {m.state === "win" ? (
                    <span className="text-accent-ink">✓ {r.price}</span>
                  ) : m.state === "fail" ? (
                    <span className="text-bad">✗ {m.note}</span>
                  ) : m.note ? (
                    <span className="text-muted">{m.note}</span>
                  ) : (
                    <span className="text-muted">{r.price}</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
      <p className="mt-5 text-sm text-ink-2" aria-live="polite">
        {scene.caption}
      </p>
    </div>
  );
}
