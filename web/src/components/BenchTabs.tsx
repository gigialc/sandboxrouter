"use client";

import { useEffect, useState } from "react";

/**
 * The detailed results, one tab at a time instead of one long page. The tab follows the URL hash, so old links
 * (/benchmarks#load) still land on the right one. Every tab is in the HTML (hidden ones too) for search and agents.
 */
export function BenchTabs({ tabs }: { tabs: { id: string; label: string; content: React.ReactNode }[] }) {
  const [active, setActive] = useState(tabs[0]?.id);
  useEffect(() => {
    const sync = () => {
      const id = window.location.hash.slice(1);
      if (!tabs.some((t) => t.id === id)) return;
      setActive(id);
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [tabs]);
  const pick = (id: string) => {
    setActive(id);
    history.replaceState(null, "", `#${id}`);
  };

  return (
    <div id="results" className="mt-16 scroll-mt-20">
      {/* One anchor per tab where the results start, so a link to a tab (/benchmarks#load) scrolls here. */}
      {tabs.map((t) => (
        <span key={t.id} id={t.id} className="block scroll-mt-20" />
      ))}
      <h2 className="text-xl font-normal tracking-[-0.02em] sm:text-2xl">All results</h2>
      <div role="tablist" aria-label="Results" className="sticky top-14 z-10 -mx-5 mt-4 flex gap-1 overflow-x-auto border-b border-line bg-bg/95 px-5 backdrop-blur sm:-mx-10 sm:px-10">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={t.id === active}
            aria-controls={`panel-${t.id}`}
            onClick={() => pick(t.id)}
            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-3 text-[13px] ${t.id === active ? "border-accent text-ink" : "border-transparent text-ink-2 hover:text-ink"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        <div key={t.id} role="tabpanel" id={`panel-${t.id}`} aria-labelledby={`tab-${t.id}`} hidden={t.id !== active}>
          {t.content}
        </div>
      ))}
    </div>
  );
}
