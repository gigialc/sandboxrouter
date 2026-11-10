"use client";

import { useState } from "react";

/**
 * A homepage section: a label, one sentence, its buttons, and a short list where one point is open at a
 * time. The visual sits beside it (swapped sides with `flip`) and stacks underneath on phones.
 */
export function Feature({
  id,
  label,
  claim,
  actions,
  points,
  visual,
  flip = false,
}: {
  id?: string;
  label: string;
  claim: string;
  actions: React.ReactNode;
  points: { title: string; body: string }[];
  visual: React.ReactNode;
  flip?: boolean;
}) {
  const [open, setOpen] = useState(0);
  return (
    <section id={id} className="grid scroll-mt-20 items-center gap-10 lg:grid-cols-[1fr_1.25fr] lg:gap-20">
      <div className={flip ? "lg:order-2" : ""}>
        <p className="text-[13px] text-muted">{label}</p>
        <h2 className="mt-3 max-w-md text-[26px] font-normal leading-[1.2] tracking-[-0.025em]">{claim}</h2>
        <div className="mt-7 flex flex-wrap gap-3">{actions}</div>
        <ul className="mt-12 max-w-md border-t border-line">
          {points.map((p, i) => (
            <li key={p.title} className="border-b border-line">
              <button
                type="button"
                onClick={() => setOpen(i)}
                aria-expanded={open === i}
                className={`w-full py-4 text-left text-[15px] ${open === i ? "text-ink" : "text-muted hover:text-ink-2"}`}
              >
                {p.title}
              </button>
              {open === i && <p className="-mt-2 pb-4 text-[14px] leading-6 text-muted">{p.body}</p>}
            </li>
          ))}
        </ul>
      </div>
      <div className={`min-w-0 ${flip ? "lg:order-1" : ""}`}>{visual}</div>
    </section>
  );
}
