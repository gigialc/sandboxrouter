import Link from "next/link";
import { REPO, site } from "@/lib/site";

export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 font-mono font-semibold tracking-tight ${className}`}>
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
        <path d="M1.5 11H7c3 0 3.5-7 8-7M7 11h8M7 11c3 0 3.5 7 8 7" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" />
        <circle cx="17.5" cy="4" r="2" fill="currentColor" />
        <circle cx="17.5" cy="11" r="2.6" fill="var(--accent)" />
        <circle cx="17.5" cy="18" r="2" fill="currentColor" />
      </svg>
      sandboxrouter
    </span>
  );
}

const NAV = [
  { href: "/sandboxes", label: "Sandboxes" },
  { href: "/rankings", label: "Rankings" },
  { href: "/playground", label: "Playground" },
  { href: "/docs", label: "Docs" },
];

export function Nav() {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-sand/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-8 px-5">
        <Link href="/" aria-label="sandboxrouter home">
          <Logo />
        </Link>
        <nav className="hidden items-center gap-6 text-sm text-ink-2 md:flex">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className="hover:text-ink">
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <a href={REPO} className="hidden text-sm text-ink-2 hover:text-ink sm:block">
            GitHub
          </a>
          <Link href="/docs#quickstart" className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-sand hover:opacity-90">
            Get started
          </Link>
        </div>
      </div>
      <nav className="flex gap-5 overflow-x-auto border-t border-line px-5 py-2 text-sm text-ink-2 md:hidden">
        {NAV.map((n) => (
          <Link key={n.href} href={n.href}>
            {n.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="mt-24 border-t border-line">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-10 text-sm text-muted sm:flex-row sm:items-center">
        <Logo className="text-ink" />
        <p>One API for every sandbox. MIT licensed. v{site.version}</p>
        <div className="flex gap-5 sm:ml-auto">
          <Link href="/sandboxes" className="hover:text-ink">Sandboxes</Link>
          <Link href="/docs" className="hover:text-ink">Docs</Link>
          <a href={REPO} className="hover:text-ink">GitHub</a>
        </div>
      </div>
    </footer>
  );
}

export function Badge({ children, tone = "plain" }: { children: React.ReactNode; tone?: "plain" | "accent" }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs ${
        tone === "accent" ? "border-accent/40 bg-accent-wash text-accent-ink" : "border-line bg-card text-ink-2"
      }`}
    >
      {children}
    </span>
  );
}

export function PageHeader({ eyebrow, title, children }: { eyebrow?: string; title: string; children?: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-6xl px-5 pt-14 pb-8">
      {eyebrow && <p className="mb-3 font-mono text-xs uppercase tracking-widest text-muted">{eyebrow}</p>}
      <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">{title}</h1>
      {children && <div className="mt-4 max-w-2xl text-lg text-ink-2">{children}</div>}
    </div>
  );
}
