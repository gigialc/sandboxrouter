"use client";

import { useEffect, useState } from "react";

/**
 * What `create()` does, replayed as terminal lines. Three scenarios, each with different providers in
 * each role, so no provider is always the one that fails or the one that wins. Failures are the kinds the
 * router really handles (your account has no balance, a provider rate-limits you); no timings are shown.
 * Prices are the catalog's list prices at the size the sandbox runs.
 */
type Line = { kind: "cmd" | "skip" | "ok" | "out"; text: string; note?: string };

const SCENARIOS: { title: string; lines: Line[] }[] = [
  {
    title: "Cheapest provider you have a key for",
    lines: [
      { kind: "cmd", text: 'sandboxrouter run "python3 -c \'print(6*7)\'"' },
      { kind: "ok", text: "daytona", note: "started · $0.067/hr" },
      { kind: "out", text: "42" },
    ],
  },
  {
    title: "Your account there has no balance",
    lines: [
      { kind: "cmd", text: 'sandboxrouter run "python3 -c \'print(6*7)\'"' },
      { kind: "skip", text: "agent37", note: "402 no balance on your account → next" },
      { kind: "ok", text: "maritime", note: "started · $0.022/hr" },
      { kind: "out", text: "42" },
    ],
  },
  {
    title: "A provider is busy",
    lines: [
      { kind: "cmd", text: 'sandboxrouter run "python3 -c \'print(6*7)\'"' },
      { kind: "skip", text: "sail", note: "429 rate limited → next" },
      { kind: "ok", text: "e2b", note: "started · $0.109/hr" },
      { kind: "out", text: "42" },
    ],
  },
];

const STEP_MS = 900;
const HOLD_MS = 2600;

export function RouteDemo() {
  const [s, setS] = useState(1);
  const [shown, setShown] = useState(SCENARIOS[1].lines.length);
  const [still, setStill] = useState(true);

  useEffect(() => {
    // Respect reduced motion: show one finished scenario and stop.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setStill(false);
    setS(0);
    setShown(1);
  }, []);

  useEffect(() => {
    if (still) return;
    const total = SCENARIOS[s].lines.length;
    const t = setTimeout(
      () => {
        if (shown < total) setShown(shown + 1);
        else {
          setS((s + 1) % SCENARIOS.length);
          setShown(1);
        }
      },
      shown < total ? STEP_MS : HOLD_MS,
    );
    return () => clearTimeout(t);
  }, [s, shown, still]);

  const sc = SCENARIOS[s];
  return (
    <figure className="border border-line bg-[#0c0f0e] text-[13px]" aria-label="What create() does with your keys">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/55">{sc.title}</span>
        <span className="flex gap-1.5" aria-hidden>
          {SCENARIOS.map((_, j) => (
            <span key={j} className={`h-1.5 w-1.5 rounded-full ${j === s ? "bg-[#2fbf7f]" : "bg-white/20"}`} />
          ))}
        </span>
      </div>
      <pre className="min-h-[8.5rem] overflow-x-auto px-4 py-3 font-mono leading-7 text-white/85" aria-live="polite">
        {sc.lines.slice(0, shown).map((l, j) => (
          <div key={j}>
            {l.kind === "cmd" && (
              <>
                <span className="text-white/40">$ </span>
                {l.text}
              </>
            )}
            {l.kind === "skip" && (
              <>
                <span className="text-[#f0b429]">! </span>
                <span className="inline-block w-24">{l.text}</span>
                <span className="text-white/55">{l.note}</span>
              </>
            )}
            {l.kind === "ok" && (
              <>
                <span className="text-[#2fbf7f]">› </span>
                <span className="inline-block w-24 text-white">{l.text}</span>
                <span className="text-white/55">{l.note}</span>
              </>
            )}
            {l.kind === "out" && <span className="text-white">{l.text}</span>}
          </div>
        ))}
      </pre>
      <figcaption className="border-t border-white/10 px-4 py-2 text-[12px] leading-5 text-white/55">
        Example runs. The router tries the providers you have keys for, cheapest first, and records each attempt on{" "}
        <code className="font-mono text-white/75">sbx.attempts</code>.
      </figcaption>
    </figure>
  );
}
