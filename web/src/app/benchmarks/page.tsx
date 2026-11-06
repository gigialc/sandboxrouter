import type { Metadata } from "next";
import Link from "next/link";
import { CodeBlock } from "@/components/code";
import { NPM, site, usd } from "@/lib/site";

export const metadata: Metadata = { title: "Benchmarks" };

const ms = (n?: number) => (n === undefined ? "n/a" : `${n.toLocaleString("en-US")} ms`);
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

export default function BenchmarksPage() {
  const rows = site.leaderboard;
  const subs = [...site.submissions].sort((a, b) => b.date.localeCompare(a.date));
  const totalRuns = subs.reduce((n, s) => n + s.runs * s.providers, 0);
  const maxCreate = Math.max(1, ...rows.map((r) => r.medianCreateMs ?? 0));
  const maxExec = Math.max(1, ...rows.map((r) => r.medianExecMs ?? 0));

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

      <table className="mt-10 w-full text-[13px]">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-[0.12em] text-muted">
            <th className="py-3 pr-4 font-normal">Provider</th>
            <th className="py-3 pr-4 font-normal">Cold start (median)</th>
            <th className="hidden py-3 pr-4 font-normal sm:table-cell">Command round trip</th>
            <th className="hidden py-3 pr-4 font-normal md:table-cell">Succeeded</th>
            <th className="py-3 font-normal">List price, 2 vCPU / 4 GB</th>
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
              <td className="py-3 font-mono tnum text-ink-2">{usd(r.hourlyUsd)}/hr</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-16 grid gap-12 border-t border-line pt-10 lg:grid-cols-2">
        <section className="prose-sr max-w-xl">
          <h2>What is measured</h2>
          <p>
            Each run asks one provider for a 2 vCPU / 4 GB sandbox, with fallback off, and times how long until it is usable:
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
            billing increments are left out; each <Link href="/#providers">provider page</Link> has the details and a link to the
            source.
          </p>
        </section>

        <section className="prose-sr max-w-xl">
          <h2>Where it ran</h2>
          <ul>
            {subs.map((s) => (
              <li key={s.date}>
                {day(s.date)}: {s.label ?? "unlabelled"} ({s.platform}), {s.runs} runs on each of {s.providers} providers
              </li>
            ))}
          </ul>
          <h2>Add a run</h2>
          <p>
            Run it with your own keys and send the report as a pull request to <code>results/</code>. Label it with a city or cloud
            region, never an address.
          </p>
          <CodeBlock title="terminal" code={`npx ${NPM} bench --runs 5 --share --label "us-east-1, c7g.large"`} />
        </section>
      </div>
    </div>
  );
}
