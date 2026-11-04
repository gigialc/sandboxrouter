"use client";

import { useState } from "react";

export function CopyButton({ text, className = "" }: { text: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
      className={`rounded-md border border-white/15 px-2 py-1 font-sans text-xs text-code-ink/80 hover:text-code-ink ${className}`}
    >
      {done ? "Copied" : "Copy"}
    </button>
  );
}

export function CodeBlock({ code, title }: { code: string; title?: string }) {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-code-bg">
      {title && (
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-2 text-xs text-code-ink/60">
          <span className="font-mono">{title}</span>
          <CopyButton text={code} />
        </div>
      )}
      <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-6 text-code-ink">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function CodeTabs({ tabs }: { tabs: { label: string; code: string }[] }) {
  const [i, setI] = useState(0);
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-code-bg shadow-[0_1px_0_rgba(0,0,0,0.04)]">
      <div className="flex items-center gap-1 border-b border-white/10 px-2 pt-2" role="tablist">
        {tabs.map((t, j) => (
          <button
            key={t.label}
            role="tab"
            aria-selected={i === j}
            onClick={() => setI(j)}
            className={`rounded-t-md px-3 py-1.5 font-mono text-xs ${
              i === j ? "bg-white/10 text-code-ink" : "text-code-ink/55 hover:text-code-ink/85"
            }`}
          >
            {t.label}
          </button>
        ))}
        <CopyButton text={tabs[i].code} className="mb-1 ml-auto" />
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-6 text-code-ink">
        <code>{tabs[i].code}</code>
      </pre>
    </div>
  );
}
