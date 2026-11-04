import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/chrome";
import { CodeBlock } from "@/components/code";
import { DEFAULT_SHAPE, REPO, cheapest, site, usd } from "@/lib/site";

export const metadata: Metadata = { title: "Rankings" };

function Bar({ pct }: { pct: number }) {
  return (
    <div className="h-2 w-full max-w-64 border-l border-line-2">
      <div className="h-2 rounded-r-sm bg-bar" style={{ width: `${Math.max(2, pct)}%` }} />
    </div>
  );
}

export default function RankingsPage() {
  const maxPrice = cheapest.at(-1)!.prices[DEFAULT_SHAPE].usd;
  const lb = site.leaderboard;
  const maxCold = Math.max(0, ...lb.map((r) => r.medianCreateMs ?? 0));

  return (
    <>
      <PageHeader eyebrow="Rankings" title="Who's cheapest, who's fastest">
        Prices come from each provider&apos;s pricing page. Speed comes from people running{" "}
        <span className="font-mono text-base">sandboxrouter bench</span> on their own accounts.
      </PageHeader>

      <div className="mx-auto grid max-w-6xl gap-8 px-5 lg:grid-cols-2">
        <section className="rounded-xl border border-line ">
          <header className="border-b border-line px-5 py-4">
            <h2 className="font-semibold">Price</h2>
            <p className="text-sm text-muted">Per hour, 2 vCPU · 4 GB, while running</p>
          </header>
          <ol className="divide-y divide-line">
            {cheapest.map((p, k) => {
              const v = p.prices[DEFAULT_SHAPE].usd;
              return (
                <li key={p.id} className="grid grid-cols-[1.5rem_8.5rem_1fr_4.5rem] items-center gap-3 px-5 py-3 text-sm">
                  <span className="text-muted tnum">{k + 1}</span>
                  <Link href={`/sandboxes/${p.id}`} className="truncate font-medium hover:underline underline-offset-4">
                    {p.name}
                  </Link>
                  <span title={`${p.name}: ${usd(v)} per hour`}>
                    <Bar pct={(v / maxPrice) * 100} />
                  </span>
                  <span className="text-right font-mono tnum">{usd(v)}</span>
                </li>
              );
            })}
          </ol>
        </section>

        <section className="rounded-xl border border-line ">
          <header className="border-b border-line px-5 py-4">
            <h2 className="font-semibold">Cold start</h2>
            <p className="text-sm text-muted">
              Time to a usable sandbox, median of {site.submissions.length} community report{site.submissions.length === 1 ? "" : "s"}
            </p>
          </header>
          {lb.length === 0 ? (
            <div className="p-6">
              <p className="text-ink-2">
                No reports yet. Be the first: run the bench with your own keys and open a pull request with the file it writes.
              </p>
              <div className="mt-4">
                <CodeBlock title="terminal" code={`npx sandboxrouter bench --runs 5 --share --label "SF, home wifi"\n# then add the .json to results/ in a PR`} />
              </div>
              <p className="mt-4 text-sm text-muted">
                Reports hold timings, your label, Node version and platform. Never keys, env vars or error text.{" "}
                <a href={`${REPO}/tree/main/results`} className="underline underline-offset-2">
                  How submissions work
                </a>
              </p>
            </div>
          ) : (
            <ol className="divide-y divide-line">
              {lb.map((r, k) => (
                <li key={r.provider} className="grid grid-cols-[1.5rem_8.5rem_1fr_4.5rem] items-center gap-3 px-5 py-3 text-sm">
                  <span className="text-muted tnum">{k + 1}</span>
                  <span className="truncate font-medium">{r.name}</span>
                  <span title={`${r.name}: median ${r.medianCreateMs} ms over ${r.submissions} reports`}>
                    {r.medianCreateMs !== undefined && <Bar pct={(r.medianCreateMs / maxCold) * 100} />}
                  </span>
                  <span className="text-right font-mono tnum">{r.medianCreateMs ?? "n/a"} ms</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </>
  );
}
