import type { Metadata } from "next";
import Link from "next/link";
import { CodeBlock } from "@/components/code";
import { NPM, REPO_PUBLIC, site, usd, type CostRow } from "@/lib/site";

export const metadata: Metadata = { title: "Benchmarks" };

const ms = (n?: number) => (n === undefined ? "n/a" : `${n.toLocaleString("en-US")} ms`);
const cents = (n: number | null) => (n === null ? "n/a" : n === 0 ? "$0" : `$${n < 0.01 ? n.toFixed(4) : n.toFixed(3)}`);
const size = (s: { vcpu: number; memoryGb: number } | null) => (s ? `${s.vcpu} vCPU / ${s.memoryGb} GB` : "n/a");

/** Where a bill came from, in a few words; the full source string goes in the tooltip. */
function billFrom(r: CostRow) {
  if (r.error) return "create failed";
  if (r.billedUsd !== null) return "provider's billing API";
  if (r.billSource?.startsWith("no billing")) return "no billing API";
  return "not posted yet";
}

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

export default function BenchmarksPage() {
  const rows = site.leaderboard;
  const subs = [...site.submissions].sort((a, b) => b.date.localeCompare(a.date));
  const totalRuns = subs.reduce((n, s) => n + s.runs * s.providers, 0);
  const maxCreate = Math.max(1, ...rows.map((r) => r.medianCreateMs ?? 0));
  const maxExec = Math.max(1, ...rows.map((r) => r.medianExecMs ?? 0));
  const costs = site.costRuns;

  return (
    <div className="px-5 sm:px-10 pt-14">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">Benchmarks</p>
      <h1 className="mt-5 max-w-2xl text-4xl font-normal leading-[1.08] tracking-[-0.035em] sm:text-[44px]">
        How fast each sandbox starts
      </h1>
      <p className="mt-5 max-w-2xl text-[15px] leading-7 text-ink-2">
        Real sandboxes on real accounts, started, used once and killed. {rows.length} providers so far,{" "}
        {totalRuns} sandboxes in total{subs[0] ? `, last run ${day(subs[0].date)}` : ""}. Providers without an account behind
        them aren&apos;t here yet; they get added as soon as someone runs them.
      </p>

      <table className="mt-10 w-full text-[14px]">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-[0.12em] text-muted">
            <th className="py-3 pr-4 font-normal">Provider</th>
            <th className="py-3 pr-4 font-normal">Cold start (median)</th>
            <th className="hidden py-3 pr-4 font-normal sm:table-cell">Command round trip</th>
            <th className="hidden py-3 pr-4 font-normal md:table-cell">Succeeded</th>
            <th className="hidden py-3 pr-4 font-normal md:table-cell">Size</th>
            <th className="py-3 font-normal">List price</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.provider} className="group border-t border-line">
              <td className="py-3 pr-4">
                <Link href={`/providers/${r.provider}`} className="text-ink group-hover:underline underline-offset-4 decoration-line-2">
                  {r.name}
                </Link>
              </td>
              <td className="py-3 pr-4">
                <div className="flex items-center gap-3" title={`${r.name}: median cold start ${ms(r.medianCreateMs)}`}>
                  <span className="w-20 font-mono tnum text-ink">{ms(r.medianCreateMs)}</span>
                  <span className="hidden h-px w-28 bg-line sm:block">
                    <span className="block h-px bg-bar" style={{ width: `${((r.medianCreateMs ?? 0) / maxCreate) * 100}%` }} />
                  </span>
                </div>
              </td>
              <td className="hidden py-3 pr-4 sm:table-cell">
                <div className="flex items-center gap-3" title={`${r.name}: median command round trip ${ms(r.medianExecMs)}`}>
                  <span className="w-20 font-mono tnum text-ink-2">{ms(r.medianExecMs)}</span>
                  <span className="hidden h-px w-20 bg-line lg:block">
                    <span className="block h-px bg-bar" style={{ width: `${((r.medianExecMs ?? 0) / maxExec) * 100}%` }} />
                  </span>
                </div>
              </td>
              <td className="hidden py-3 pr-4 font-mono tnum text-ink-2 md:table-cell">{Math.round(r.successRate * 100)}%</td>
              <td className="hidden py-3 pr-4 font-mono tnum text-ink-2 md:table-cell">
                {r.size.vcpu} vCPU / {r.size.memoryGb} GB
              </td>
              <td className="py-3 font-mono tnum text-ink-2">{usd(r.hourlyUsd)}/hr</td>
            </tr>
          ))}
        </tbody>
      </table>

      {costs.length > 0 && (
        <section id="real-cost" className="mt-20 scroll-mt-20">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-accent">Real cost</p>
          <h2 className="mt-3 text-2xl font-normal tracking-[-0.025em] sm:text-[28px]">What providers actually billed</h2>
          <p className="mt-4 max-w-2xl text-[14px] leading-6 text-ink-2">
            List price is a promise; the bill is what happened. Each row is one sandbox started on a real account, kept busy for a
            fixed time with every core loaded, then killed. &ldquo;List price × time&rdquo; is what the catalog predicts;
            &ldquo;Billed&rdquo; is read back from the provider&apos;s own billing API.
          </p>
          <div className="mt-6 overflow-x-auto">
            <table className="w-full min-w-[720px] text-[14px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-[0.12em] text-muted">
                  <th className="py-3 pr-4 font-normal">Provider</th>
                  <th className="py-3 pr-4 font-normal">Asked for</th>
                  <th className="py-3 pr-4 font-normal">Got</th>
                  <th className="py-3 pr-4 font-normal">Ran</th>
                  <th className="py-3 pr-4 font-normal">List price × time</th>
                  <th className="py-3 pr-4 font-normal">Billed</th>
                  <th className="py-3 pr-4 font-normal">Billed ÷ list</th>
                  <th className="py-3 font-normal">Bill from</th>
                </tr>
              </thead>
              <tbody>
                {costs.map((r) => {
                  const ratio = r.billedUsd !== null && r.predictedUsd ? r.billedUsd / r.predictedUsd : null;
                  return (
                    <tr key={`${r.date}-${r.provider}`} className="border-t border-line">
                      <td className="py-3 pr-4">
                        <Link href={`/providers/${r.provider}`} className="text-ink hover:underline underline-offset-4 decoration-line-2">
                          {r.name}
                        </Link>
                      </td>
                      <td className="py-3 pr-4 tnum text-ink-2">{size(r.requested)}</td>
                      <td className="py-3 pr-4 tnum text-ink-2">{size(r.delivered)}</td>
                      <td className="py-3 pr-4 font-mono tnum text-ink-2">{r.seconds === null ? "n/a" : `${r.seconds} s`}</td>
                      <td className="py-3 pr-4 font-mono tnum text-ink-2">{cents(r.predictedUsd)}</td>
                      <td className="py-3 pr-4 font-mono tnum text-ink">{cents(r.billedUsd)}</td>
                      <td className="py-3 pr-4 font-mono tnum text-ink">{ratio === null ? "n/a" : `${Math.round(ratio * 100)}%`}</td>
                      <td className="py-3 text-muted" title={r.error ?? r.billSource ?? undefined}>
                        {billFrom(r)}
                        {r.by && <span className="block text-[11px]">by @{r.by}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-4 max-w-3xl text-[13px] leading-6 text-ink-2">
            Billed and list price differ for reasons a price table can&apos;t show: some providers bill only while a request is
            open, some add a one-off creation fee that dominates a short run (Sail, on its free plan), and an account on a
            plan with included usage can be billed nothing (Maritime). &ldquo;Got&rdquo; is what the sandbox itself reports (nproc,
            MemTotal). Run <code className="font-mono">sandboxrouter cost run</code> to measure your own.
          </p>
        </section>
      )}

      <div className="mt-16 grid grid-cols-1 gap-12 border-t border-line pt-10 lg:grid-cols-2">
        <section className="prose-sr max-w-xl">
          <h2>What is measured</h2>
          <p>
            Each run asks one provider for a 2 vCPU / 4 GB sandbox, or for its default size where the
            default image fixes the size whatever you ask (E2B, OpenScale and Daytona; the Size column says which), with fallback off, and times how long until it is usable:
            that&apos;s the <strong>cold start</strong>. Then it runs <code>echo ok</code> and times the answer: the{" "}
            <strong>command round trip</strong>. Then it kills the sandbox. A run counts as failed if any of that goes wrong.
          </p>
          <p>
            The numbers include the network between the machine running the test and each provider, so where it ran matters as
            much as who ran it. Each location is listed below. With several locations, a provider&apos;s number is the median of
            each location&apos;s median, so one heavy submitter can&apos;t move it.
          </p>
          <p>
            Prices are each provider&apos;s public list price for the size, not a bill. Disk, network, monthly plans and minimum
            billing increments are left out; each <Link href="/providers">provider page</Link> has the details and a link to the
            source.
          </p>
        </section>

        <section className="prose-sr max-w-xl">
          <h2>Where it ran</h2>
          <ul>
            {subs.map((s) => (
              <li key={s.date}>
                {day(s.date)}: {s.label ?? "unlabelled"} ({s.platform}), {s.runs} runs on each of {s.providers} providers
                {s.by ? `, by @${s.by}` : ""}
              </li>
            ))}
          </ul>
          <h2>Add a run</h2>
          <p>
            Run it with your own keys{REPO_PUBLIC ? <> and send the report as a pull request to <code>results/</code></> : null}.
            Label it with a city or cloud region, never an address.
          </p>
          <CodeBlock title="terminal" code={`npx ${NPM} bench --runs 5 --share --label "us-east-1, c7g.large" --by YOUR_GITHUB_USERNAME`} />
        </section>
      </div>
    </div>
  );
}
