"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * Below `sm` the header has no room for its links (about 370px of them on a 335px row), so they sit behind a
 * Menu button. The header stays mounted across navigations, so each link closes the menu itself.
 * Everything is positioned `absolute` against the sticky header: its backdrop-blur would trap `fixed` children.
 */
export function MobileNav({ links }: { links: { href: string; label: string }[] }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="sm:hidden">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="mobile-nav"
        onClick={() => setOpen(!open)}
        className="flex h-11 items-center px-2 text-[13px] text-ink-2 hover:text-ink"
      >
        {open ? "Close" : "Menu"}
      </button>
      {open && (
        <>
          <div aria-hidden="true" onClick={() => setOpen(false)} className="absolute inset-x-0 top-full h-dvh" />
          <nav id="mobile-nav" className="absolute inset-x-0 top-full border-y border-line bg-bg px-5">
            {links.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                onClick={() => setOpen(false)}
                className="block border-b border-line py-3 text-[15px] text-ink last:border-b-0"
              >
                {n.label}
              </Link>
            ))}
          </nav>
        </>
      )}
    </div>
  );
}
