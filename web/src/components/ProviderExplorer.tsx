"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { CAPABILITY_LABEL, DEFAULT_SHAPE, shapeLabel, site, usd, type SiteProvider } from "@/lib/site";

const FILTERS = ["pause", "gpu", "custom-image", "computers"] as const;
type Sort = "price" | "name" | "default";

function has(p: SiteProvider, cap: string) {
  return cap === "computers" ? p.computers.length > 0 : p.capabilities.includes(cap);
}

export function ProviderExplorer() {
  const [shape, setShape] = useState(DEFAULT_SHAPE);
  const [need, setNeed] = useState<string[]>([]);
  const [sort, setSort] = useState<Sort>("price");
  const [q, setQ] = useState("");

  const rows = useMemo(() => {
    const list = site.providers.filter((p) => need.every((c) => has(p, c)) && p.name.toLowerCase().includes(q.toLowerCase()));
    return list.sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      if (sort === "default") return a.order - b.order;
      const fa = a.prices[shape].unfit ? 1 : 0;
      const fb = b.prices[shape].unfit ? 1 : 0;
      return fa - fb || a.prices[shape].usd - b.prices[shape].usd;
    });
  }, [shape, need, sort, q]);

  const max = Math.max(...rows.filter((r) => !r.prices[shape].unfit).map((r) => r.prices[shape].usd), 0.0001);

  return (
    <div className="mx-auto max-w-6xl px-5">
      <div className="flex flex-col gap-4 rounded-xl border border-line p-4 lg:flex-row lg:items-center">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-xs text-muted">Machine</span>
          {site.shapes.map((s) => (
            <button
              key={s}
              onClick={() => setShape(s)}
              className={`rounded-full border px-3 py-1 text-xs tnum ${s === shape ? "border-ink bg-ink text-sand" : "border-line hover:border-line-2"}`}
            >
              {shapeLabel(s)}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
          <span className="mr-1 text-xs text-muted">Needs</span>
          {FILTERS.map((f) => {
            const on = need.includes(f);
            return (
              <button
                key={f}
                aria-pressed={on}
                onClick={() => setNeed(on ? need.filter((x) => x !== f) : [...need, f])}
                className={`rounded-full border px-3 py-1 text-xs ${on ? "border-ink bg-ink text-sand" : "border-line hover:border-line-2"}`}
              >
                {CAPABILITY_LABEL[f]}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search providers"
          aria-label="Search providers"
          className="w-56 rounded-lg border border-line px-3 py-2 outline-none focus:border-line-2"
        />
        <span className="text-muted">{rows.length} shown</span>
        <label className="ml-auto flex items-center gap-2 text-muted">
          Sort
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="rounded-lg border border-line px-2 py-1.5 text-ink">
            <option value="price">Price, low to high</option>
            <option value="default">Routing order</option>
            <option value="name">Name</option>
          </select>
        </label>
      </div>

      <div className="mt-4 overflow-x-auto rounded-xl border border-line ">
        <table className="w-full text-sm md:min-w-[720px]">
          <thead>
            <tr className="border-b border-line-2 text-left text-xs text-muted">
              <th className="px-5 py-3 font-medium">Provider</th>
              <th className="px-3 py-3 font-medium">Price per hour, {shapeLabel(shape)}</th>
              <th className="hidden px-3 py-3 font-medium sm:table-cell">Can do</th>
              <th className="hidden px-5 py-3 text-right font-medium md:table-cell">Max size</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((p) => {
              const price = p.prices[shape];
              const pct = price.unfit ? 0 : Math.max(2, (price.usd / max) * 100);
              return (
                <tr key={p.id} className="group hover:bg-accent-wash">
                  <td className="px-4 py-4 sm:px-5">
                    <Link href={`/sandboxes/${p.id}`} className="font-medium group-hover:underline underline-offset-4">
                      {p.name}
                    </Link>
                    {p.order === 0 && <span className="ml-2 rounded-full bg-ink px-1.5 py-px align-middle text-[10px] font-medium text-sand">default</span>}
                    <div className="mt-0.5 font-mono text-xs text-muted">{p.id}</div>
                  </td>
                  <td className="px-3 py-4">
                    {price.unfit ? (
                      <span className="text-muted">Can&apos;t: {price.unfit}</span>
                    ) : (
                      <div className="flex items-center gap-3" title={`${p.name}: ${usd(price.usd)} per hour at list price`}>
                        <div className="h-2 w-16 border-l border-line-2 sm:w-40">
                          <div className="h-2 rounded-r-sm bg-bar" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="font-mono tnum">{usd(price.usd)}</span>
                      </div>
                    )}
                  </td>
                  <td className="hidden px-3 py-4 sm:table-cell">
                    <div className="flex flex-wrap gap-1.5">
                      {[...p.capabilities, ...(p.computers.length ? ["computers"] : [])].map((c) => (
                        <span key={c} className="rounded-full border border-line px-2 py-0.5 text-xs text-ink-2">
                          {CAPABILITY_LABEL[c] ?? c}
                        </span>
                      ))}
                      {p.capabilities.length === 0 && !p.computers.length && <span className="text-xs text-muted">Core API</span>}
                    </div>
                  </td>
                  <td className="hidden px-5 py-4 text-right font-mono text-xs text-ink-2 tnum md:table-cell">
                    {p.limits.maxVcpu} vCPU · {p.limits.maxMemoryGb} GB
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-5 py-10 text-center text-muted">
                  No provider has all of those. Remove a filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-muted">
        List prices while running, from each provider&apos;s pricing page. Some bill only active CPU, so mostly idle work costs
        less. Open a provider for its notes and source.
      </p>
    </div>
  );
}
