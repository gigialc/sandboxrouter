import type { Metadata } from "next";
import { pageAlternates } from "@/lib/public-pages";
import { ConditionalStartFeeNote, hasStartFee } from "@/components/ConditionalStartFeeNote";
import { ProviderLogo } from "@/components/ProviderName";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CodeBlock } from "@/components/code";
import { time } from "@/components/results";
import { CAPABILITY_LABEL, fixedPrice, NPM, PACKAGE, provider, REPO, REPO_PUBLIC, shapeLabel, site, usd } from "@/lib/site";

const billDollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 6 });

export function generateStaticParams() {
  return site.providers.map((p) => ({ id: p.id }));
}

export async function generateMetadata({ params }: PageProps<"/providers/[id]">): Promise<Metadata> {
  const { id } = await params;
  const p = provider(id);
  return p ? { title: p.name, alternates: pageAlternates(`/providers/${p.id}`) } : { title: "Not found" };
}

export default async function ProviderPage({ params }: PageProps<"/providers/[id]">) {
  const { id } = await params;
  const p = provider(id);
  if (!p) notFound();

  const pkg = PACKAGE[p.id];
  const env = p.credentials.length
    ? p.credentials.map((g) => g.map((k) => `export ${k}=...`).join("\n")).join("\n# or\n")
    : "# no key needed: start Docker on this machine";
  const setup = `npm i ${NPM}${pkg ? ` ${pkg}` : ""}\n${env}`;
  const code = `import { Router } from "${NPM}";

const router = new Router();
const sbx = await router.create({}, { provider: "${p.id}" });
await sbx.exec("uname -a", { onStdout: (c) => process.stdout.write(c) });
await sbx.kill();`;
  const caps = [...p.capabilities, ...(p.computers.length ? ["computers"] : [])];

  const lb = site.leaderboard.find((r) => r.provider === p.id);
  const costs = site.costRuns.filter((r) => r.provider === p.id);
  const sizeRun = costs.find((r) => !r.error && r.delivered);
  const size = sizeRun?.delivered;
  const usage = costs.find((r) => !r.error && r.billKind === "provider-usage" && r.billedUsd !== null);
  const estimate = costs.find((r) => !r.error && r.billKind === "provider-estimate" && r.billedUsd !== null);
  const bill = usage ?? estimate;
  const noBillingApi = costs.some((r) => r.billSource?.startsWith("no billing"));
  const total = site.checkSteps.length - (p.check?.skipped.length ?? 0);
  const hidden = Boolean(p.noBenchmarks);
  const credit = (by: string | null) => (by ? ` by @${by}` : "");
  const facts: [string, string, string][] = [];
  if (p.check) {
    facts.push(["Real-account check", `${p.check.passed} / ${total} steps`, `${p.check.date.slice(0, 10)}${credit(p.check.by)}`]);
  }
  if (!hidden && lb) {
    if (lb.medianCreateMs !== undefined) {
      facts.push([
        "Median create",
        time(lb.medianCreateMs),
        `${lb.size.vcpu} vCPU / ${lb.size.memoryGb} GB · ${lb.runs} requests · ${lb.measuredAt.slice(0, 10)}`,
      ]);
    }
    if (lb.runs > 0) facts.push(["Ready", `${Math.round(lb.successRate * 100)}%`, "Excluding recorded limit refusals"]);
  }
  if (!hidden && size && sizeRun) {
    facts.push(["Measured resources", `${size.vcpu} vCPU / ${size.memoryGb} GB`, `Requested ${sizeRun.requested.vcpu} vCPU / ${sizeRun.requested.memoryGb} GB`]);
  }
  if (!hidden && bill && bill.billedUsd !== null) {
    const note = [
      bill.predictedUsd === null ? null : `${billDollars.format(bill.predictedUsd)} list estimate`,
      bill.billResolutionUsd ? `${billDollars.format(bill.billResolutionUsd)} reporting increments` : null,
      `${bill.date.slice(0, 10)}${credit(bill.by)}`,
    ].filter(Boolean).join(" · ");
    facts.push([usage ? "Provider-reported usage" : "Provider estimate", billDollars.format(bill.billedUsd), note]);
  }
  const gaps = [
    !p.check ? "a real-account check" : null,
    !hidden && lb?.medianCreateMs === undefined ? "startup timing" : null,
    !hidden && !size ? "delivered resources" : null,
    !hidden && !usage && !noBillingApi ? "provider usage charges" : null,
  ].filter(Boolean);
  const help = [
    ...(p.live.status !== "passed" ? [`npx ${NPM} check --provider ${p.id} --save --by YOUR_GITHUB_USERNAME`] : []),
    ...(lb?.medianCreateMs === undefined && !hidden ? [`npx ${NPM} bench --provider ${p.id} --runs 5 --share --label "your city or cloud region" --by YOUR_GITHUB_USERNAME`] : []),
    ...((!size || (!usage && !noBillingApi)) && !hidden ? [`npx ${NPM} cost run --provider ${p.id} --minutes 10 --by YOUR_GITHUB_USERNAME`] : []),
  ];

  return (
    <div className="px-5 sm:px-10 pt-12">
      <Link href="/providers" className="text-[13px] text-muted hover:text-ink">
        ← Providers
      </Link>
      <h1 className="mt-8 flex items-center gap-4 text-4xl font-normal tracking-[-0.035em]">
        <ProviderLogo id={p.id} name={p.name} size={36} />
        {p.name}
      </h1>
      <p className="mt-2 font-mono text-[12px] text-muted">provider: &quot;{p.id}&quot;</p>
      {p.access && (
        <p className="mt-5 max-w-2xl border-l-2 border-line-2 pl-3 text-[14px] leading-6 text-ink">
          {p.access.status === "waitlist" ? "Sign-up is waitlisted" : "Not taking new accounts"}: {p.access.note}. Checked {p.access.checked}.
        </p>
      )}
      {p.pricing.note && <p className="mt-5 max-w-2xl text-[14px] leading-6 text-ink-2">{p.pricing.note[0].toUpperCase() + p.pricing.note.slice(1)}.</p>}
      {p.defaultSize && (
        <p className="mt-3 max-w-2xl border-l-2 border-accent pl-3 text-[14px] leading-6 text-ink">
          Always runs at {p.defaultSize.vcpu} vCPU / {p.defaultSize.memoryGb} GB unless you pass your own image (
          <code className="font-mono text-[12.5px]">image.{p.id}</code>), so the router only sends it work that fits.
        </p>
      )}

      <div className="mt-12 grid grid-cols-1 gap-12 md:grid-cols-2">
        <section>
          <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">List price per hour</h2>
          <table className="mt-4 w-full text-[14px]">
            <tbody>
              {site.shapes.map((s) => (
                <tr key={s} className="border-t border-line">
                  <td className="py-2.5 text-ink-2 tnum">{shapeLabel(s)}</td>
                  <td className="py-2.5 text-right font-mono tnum">
                    {fixedPrice(p, s) ? (
                      <span className="text-muted">
                        {usd(fixedPrice(p, s)!.usd)} at {fixedPrice(p, s)!.size} only
                      </span>
                    ) : p.prices[s].unfit ? (
                      <span className="text-muted">{p.prices[s].unfit}</span>
                    ) : (
                      usd(p.prices[s].usd)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="mt-4 grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1 text-[13px] leading-6 text-ink-2">
            <dt className="text-muted">Source</dt>
            <dd>
              <a href={p.pricing.source} className="underline decoration-line-2 underline-offset-2 hover:text-ink">
                {new URL(p.pricing.source).hostname}
              </a>
              , {p.pricing.checked} (an estimate, not a bill)
            </dd>
            {!p.local && (
              <>
                <dt className="text-muted">Billing</dt>
                <dd>{p.billing === "active-cpu" ? "CPU only while busy; shown with every core busy" : "the size you ask for, while it runs"}</dd>
                {hasStartFee([p.id]) && (
                  <>
                    <dt className="text-muted">Start fees</dt>
                    <dd><ConditionalStartFeeNote id={p.id} /></dd>
                  </>
                )}
                <dt className="text-muted">Plan</dt>
                <dd>{p.plan ? `${p.planLabel}: ${p.plan.note}` : "none needed"}</dd>
              </>
            )}
          </dl>
        </section>

        <section>
          <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">Adapter</h2>
          <dl className="mt-4 text-[13px]">
            {[
              ["Supports", ["Exec + streaming", "Files", ...caps.map((c) => CAPABILITY_LABEL[c] ?? c)].join(" · ")],
              ["Max size", `${p.limits.maxVcpu} vCPU · ${p.limits.maxMemoryGb} GB`],
              ...(p.computers.length ? [["Computers", p.computers.join(", ")]] : []),
              [
                "Routing",
                p.local
                  ? "Only when you ask for it by name"
                  : p.access
                    ? "Chosen when it's the cheapest fit, if you already have a key"
                    : "Chosen when it's the cheapest fit, or as a fallback",
              ],
              ["Docs", new URL(p.docs).hostname],
            ].map(([k, v]) => (
              <div key={k} className="flex gap-4 border-t border-line py-2.5">
                <dt className="w-24 shrink-0 text-muted">{k}</dt>
                <dd className="text-ink-2">{k === "Docs" ? <a href={p.docs} className="underline decoration-line-2 underline-offset-2 hover:text-ink">{v}</a> : v}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>

      {!p.local && (
        <section className="mt-12">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">Measured on real accounts</h2>
          {facts.length > 0 && (
            <dl className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-px border border-line bg-line">
              {facts.map(([k, v, sub]) => (
                <div key={k} className="bg-bg p-4">
                  <dt className="text-[11px] uppercase tracking-[0.12em] text-muted">{k}</dt>
                  <dd className="mt-2 font-mono text-[15px] tnum text-ink">{v}</dd>
                  <dd className="mt-1 text-[13px] leading-6 text-ink-2">{sub}</dd>
                </div>
              ))}
            </dl>
          )}
          {gaps.length > 0 && <p className="mt-4 max-w-2xl text-[13px] text-muted">Awaiting results for {gaps.join(", ")}.</p>}
          {!hidden && lb?.runs === 0 && (
            <p className="mt-3 max-w-2xl text-[13px] text-muted">All startup requests were refused by the test account limit.</p>
          )}
          {!hidden && noBillingApi && !usage && (
            <p className="mt-3 max-w-2xl text-[13px] text-muted">The cost run had no billing API to query. A provider dashboard or invoice can supply usage charges.</p>
          )}
          {p.noBenchmarks && (
            <p className="mt-4 max-w-2xl text-[14px] leading-6 text-ink-2">
              Speed, size and billing results for {p.name} aren&apos;t published here:{" "}
              <a href={p.noBenchmarks.source} className="underline decoration-line-2 underline-offset-2 hover:text-ink">
                {p.noBenchmarks.clause}
              </a>
              . Its list price above comes from its public pricing page, and the router works with it like any other provider; run{" "}
              <code className="font-mono text-[12px]">sandboxrouter bench --provider {p.id}</code> on your own account to see its numbers.
            </p>
          )}
          {help.length > 0 && (
            <div className="mt-6 border-l-2 border-accent pl-4">
              <h3 className="text-[15px] text-ink">Help verify {p.name}</h3>
              <p className="mt-2 max-w-2xl text-[14px] leading-6 text-ink-2">
                Have a {p.name} account? These commands start real sandboxes and write result files. Provider charges may apply. Results never include your keys.
                {REPO_PUBLIC
                  ? " Run them in a clone of the repo and open a pull request with the files: CI checks every file for keys and impossible numbers, and a maintainer reviews each one before it shows here."
                  : ""}
              </p>
              <div className="mt-4">
                <CodeBlock title="terminal" code={help.join("\n")} />
              </div>
            </div>
          )}
        </section>
      )}

      {p.check && (
        <section className="mt-12">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">Real-account check, step by step</h2>
            <p className="mt-4 text-[13px] text-ink-2">
              {p.check.passed} of {total} steps passed on a real account, {p.check.date.slice(0, 10)} (v{p.check.version})
              {credit(p.check.by)}.
            </p>
            <ul className="mt-3 grid gap-x-10 text-[13px] sm:grid-cols-2">
              {site.checkSteps.map((step) => {
                const st = p.check!.steps[step];
                const why = [...p.check!.failed, ...p.check!.notes].find((f) => f.step === step)?.detail;
                const mark = { pass: ["passed", "text-ok"], info: ["passed, with a note", "text-ok"], fail: ["failed", "text-bad"], skip: ["n/a", "text-muted"], "not run": ["not run", "text-muted"] }[st];
                return (
                  <li key={step} className="flex gap-4 border-t border-line py-2.5">
                    <span className="flex-1 text-ink-2">
                      {step}
                      {why && <span className="block text-[12px] text-muted">{why}</span>}
                    </span>
                    <span className={`shrink-0 font-mono text-[12px] ${mark[1]}`}>{mark[0]}</span>
                  </li>
                );
              })}
            </ul>
        </section>
      )}

      <div className="mt-12 grid grid-cols-1 gap-4">
        <CodeBlock title="setup" code={setup} />
        <CodeBlock title={`use ${p.name}`} code={code} />
      </div>

      <p className="mt-10 max-w-2xl text-[13px] leading-6 text-muted">
        sandboxRouter isn&apos;t affiliated with {p.name}. Prices come from its public pricing page and results from our own runs.
        Something wrong or out of date?{" "}
        <a
          href={`${REPO}/issues/new?title=${encodeURIComponent(`Correction: ${p.name}`)}&labels=correction&body=${encodeURIComponent(`What's wrong on https://www.sandboxrouter.ai/providers/${p.id}, and a link to the source:\n\n`)}`}
          className="text-ink underline underline-offset-4 decoration-line-2 hover:decoration-ink"
        >
          Report a correction
        </a>
        .
      </p>
    </div>
  );
}
