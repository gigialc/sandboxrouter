import Link from "next/link";
import { MobileNav } from "@/components/MobileNav";
import { HOSTED_URL, NPM_URL, REPO, REPO_PUBLIC, site } from "@/lib/site";

export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 text-[15px] tracking-tight ${className}`}>
      <svg width="18" height="18" viewBox="0 0 22 22" aria-hidden="true">
        <path d="M1.5 11H7c3 0 3.5-7 8-7M7 11h8M7 11c3 0 3.5 7 8 7" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="square" />
        <rect x="15.5" y="2" width="4" height="4" className="fill-accent" />
        <rect x="15" y="8.5" width="5" height="5" className="fill-accent" />
        <rect x="15.5" y="16" width="4" height="4" className="fill-accent" />
      </svg>
      sandboxrouter
    </span>
  );
}

const NAV = [
  { href: "/#providers", label: "Providers" },
  { href: "/#desktops", label: "Desktops" },
  { href: "/benchmarks", label: "Benchmarks" },
  { href: "/docs", label: "Docs" },
  { href: "/playground", label: "Playground" },
  { href: "/#hosted", label: "Pricing" },
  ...(REPO_PUBLIC ? [{ href: REPO, label: "GitHub" }] : []),
];

export function Nav() {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg/90 backdrop-blur-md">
      <div className="flex h-14 items-center px-5 sm:px-10">
        <Link href="/" aria-label="sandboxrouter home">
          <Logo />
        </Link>
        <nav className="ml-auto flex items-center gap-7 text-[13px] text-ink-2">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className="hidden hover:text-ink sm:block">
              {n.label}
            </Link>
          ))}
          <MobileNav links={NAV} />
          <a href={`${HOSTED_URL}/dashboard`} className="rounded-full bg-ink px-4 py-1.5 text-[13px] font-medium text-bg hover:bg-ink-2">
            Get a key
          </a>
        </nav>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="mt-32 border-t border-line">
      <div className="flex flex-col gap-4 px-5 sm:px-10 py-10 text-[13px] text-muted sm:flex-row sm:items-center">
        <Logo className="text-ink-2" />
        <span>Open source, MIT. v{site.version}. Hosted keys by AlgiAI, Corp.</span>
        <div className="flex flex-wrap gap-x-6 gap-y-3 sm:ml-auto">
          <Link href="/benchmarks" className="hover:text-ink">Benchmarks</Link>
          <Link href="/docs" className="hover:text-ink">Docs</Link>
          <Link href="/playground" className="hover:text-ink">Playground</Link>
          {REPO_PUBLIC && <a href={REPO} className="hover:text-ink">GitHub</a>}
          <a href={NPM_URL} className="hover:text-ink">npm</a>
          <a href={`${HOSTED_URL}/dashboard`} className="hover:text-ink">Dashboard</a>
          <a href={`${HOSTED_URL}/terms`} className="hover:text-ink">Terms</a>
          <a href={`${HOSTED_URL}/privacy`} className="hover:text-ink">Privacy</a>
        </div>
      </div>
    </footer>
  );
}

export function Tag({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex items-center border border-line-2 px-1.5 py-px text-[11px] text-ink-2">{children}</span>;
}

export function Button({ href, children, primary = false }: { href: string; children: React.ReactNode; primary?: boolean }) {
  const cls = primary ? "bg-accent text-white hover:bg-accent-ink" : "border border-line-2 bg-bg text-ink hover:bg-panel";
  const external = href.startsWith("http");
  return external ? (
    <a href={href} className={`inline-flex h-9 items-center rounded-full px-4 text-[13px] font-medium ${cls}`}>
      {children}
    </a>
  ) : (
    <Link href={href} className={`inline-flex h-9 items-center rounded-full px-4 text-[13px] font-medium ${cls}`}>
      {children}
    </Link>
  );
}

/**
 * A table that is wider than a phone scrolls sideways inside this box instead of widening the page.
 * Below `sm` it runs to the screen edges (cancelling the page's px-5), so the cut-off reads as "more this way".
 */
export function TableScroll({ children }: { children: React.ReactNode }) {
  return <div className="-mx-5 overflow-x-auto px-5 sm:mx-0 sm:px-0">{children}</div>;
}

export function SectionTitle({ id, kicker, children }: { id?: string; kicker?: string; children: React.ReactNode }) {
  return (
    <div id={id} className="scroll-mt-20">
      {kicker && <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.18em] text-accent">{kicker}</p>}
      <h2 className="text-2xl font-normal tracking-[-0.025em] sm:text-[28px]">{children}</h2>
    </div>
  );
}
