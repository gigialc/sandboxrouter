import Link from "next/link";
import { REPO, site } from "@/lib/site";

export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 text-[15px] tracking-tight ${className}`}>
      <svg width="18" height="18" viewBox="0 0 22 22" aria-hidden="true">
        <path d="M1.5 11H7c3 0 3.5-7 8-7M7 11h8M7 11c3 0 3.5 7 8 7" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="square" />
        <rect x="15.5" y="2" width="4" height="4" fill="currentColor" />
        <rect x="15" y="8.5" width="5" height="5" fill="currentColor" />
        <rect x="15.5" y="16" width="4" height="4" fill="currentColor" />
      </svg>
      sandboxrouter
    </span>
  );
}

const NAV = [
  { href: "/#providers", label: "Providers" },
  { href: "/docs", label: "Docs" },
  { href: "/playground", label: "Playground" },
];

export function Nav() {
  return (
    <header className="sticky top-0 z-30 border-b border-line/70 bg-bg/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-5xl items-center px-6">
        <Link href="/" aria-label="sandboxrouter home">
          <Logo />
        </Link>
        <nav className="ml-auto flex items-center gap-7 text-[13px] text-ink-2">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className="hidden hover:text-ink sm:block">
              {n.label}
            </Link>
          ))}
          <a href={REPO} className="bg-ink px-3 py-1.5 text-[13px] font-medium text-bg hover:bg-white">
            GitHub
          </a>
        </nav>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="mt-32 border-t border-line">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 px-6 py-10 text-[13px] text-muted sm:flex-row sm:items-center">
        <Logo className="text-ink-2" />
        <span>Free and open source. MIT. v{site.version}</span>
        <div className="flex gap-6 sm:ml-auto">
          <Link href="/docs" className="hover:text-ink">Docs</Link>
          <Link href="/playground" className="hover:text-ink">Playground</Link>
          <a href={REPO} className="hover:text-ink">GitHub</a>
          <a href="https://www.npmjs.com/package/@sandboxrouter/sdk" className="hover:text-ink">npm</a>
        </div>
      </div>
    </footer>
  );
}

export function Tag({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex items-center border border-line-2 px-1.5 py-px text-[11px] text-ink-2">{children}</span>;
}

export function Button({ href, children, primary = false }: { href: string; children: React.ReactNode; primary?: boolean }) {
  const cls = primary ? "bg-ink text-bg hover:bg-white" : "bg-panel-2 text-ink hover:bg-line-2";
  const external = href.startsWith("http");
  return external ? (
    <a href={href} className={`inline-flex h-9 items-center px-4 text-[13px] font-medium ${cls}`}>
      {children}
    </a>
  ) : (
    <Link href={href} className={`inline-flex h-9 items-center px-4 text-[13px] font-medium ${cls}`}>
      {children}
    </Link>
  );
}

export function SectionTitle({ id, kicker, children }: { id?: string; kicker?: string; children: React.ReactNode }) {
  return (
    <div id={id} className="scroll-mt-20">
      {kicker && <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.18em] text-muted">{kicker}</p>}
      <h2 className="text-2xl font-normal tracking-[-0.025em] sm:text-[28px]">{children}</h2>
    </div>
  );
}
