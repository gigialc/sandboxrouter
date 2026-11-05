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
      className={`px-2 py-1 text-[11px] text-muted hover:text-ink ${className}`}
    >
      {done ? "Copied" : "Copy"}
    </button>
  );
}

export function CodeBlock({ code, title }: { code: string; title?: string }) {
  return (
    <div className="border border-line bg-panel">
      {title && (
        <div className="flex items-center justify-between border-b border-line pl-4 pr-2 py-1.5 text-[11px] text-muted">
          <span className="font-mono">{title}</span>
          <CopyButton text={code} />
        </div>
      )}
      <pre className="overflow-x-auto p-4 font-mono text-[12.5px] leading-6 text-ink-2">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function CodeTabs({ tabs }: { tabs: { label: string; code: string }[] }) {
  const [i, setI] = useState(0);
  return (
    <div className="border border-line bg-panel">
      <div className="flex items-center border-b border-line pr-2" role="tablist">
        {tabs.map((t, j) => (
          <button
            key={t.label}
            role="tab"
            aria-selected={i === j}
            onClick={() => setI(j)}
            className={`-mb-px border-b px-4 py-2 text-[12px] ${i === j ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink-2"}`}
          >
            {t.label}
          </button>
        ))}
        <CopyButton text={tabs[i].code} className="ml-auto" />
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-[12.5px] leading-6 text-ink-2">
        <code>{tabs[i].code}</code>
      </pre>
    </div>
  );
}

export function InstallChip({ cmd }: { cmd: string }) {
  return (
    <div className="inline-flex h-9 items-center rounded-full border border-line bg-panel pl-1 font-mono text-[12.5px]">
      <span className="select-all py-2 pl-3 pr-1 text-ink-2">
        <span className="text-muted">$ </span>
        {cmd}
      </span>
      <CopyButton text={cmd} className="mr-1" />
    </div>
  );
}
