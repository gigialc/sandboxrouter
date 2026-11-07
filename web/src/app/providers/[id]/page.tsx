import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CodeBlock } from "@/components/code";
import { CAPABILITY_LABEL, fixedPrice, NPM, PACKAGE, provider, REPO_PUBLIC, shapeLabel, site, usd } from "@/lib/site";

export function generateStaticParams() {
  return site.providers.map((p) => ({ id: p.id }));
}

export async function generateMetadata({ params }: PageProps<"/providers/[id]">): Promise<Metadata> {
  const { id } = await params;
  const p = provider(id);
  return { title: p ? p.name : "Not found" };
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
const sbx = await router.create({ vcpu: 2, memoryGb: 4 }, { provider: "${p.id}" });
await sbx.exec("uname -a", { onStdout: (c) => process.stdout.write(c) });
await sbx.kill();`;
  const caps = [...p.capabilities, ...(p.computers.length ? ["computers"] : [])];

  // What has been measured on real accounts, and what's still missing.
  const lb = site.leaderboard.find((r) => r.provider === p.id);
  const reports = site.submissions.filter((s) => s.ids.includes(p.id));
  const costs = site.costRuns.filter((r) => r.provider === p.id);
  const cost = costs.find((r) => !r.error) ?? costs[0];
  const noBillingApi = !!cost?.billSource?.startsWith("no billing");
  const billed = cost && cost.billedUsd !== null && cost.predictedUsd ? { usd: cost.billedUsd, list: cost.predictedUsd } : null;
  const total = site.checkSteps.length - (p.check?.skipped.length ?? 0);
  const credit = (by: string | null) => (by ? ` by @${by}` : "");
  const facts: [string, string, string][] = [
    [
      "Real-account check",
      p.check ? `${p.check.passed} / ${total} steps` : "not run yet",
      p.check ? `${p.check.date.slice(0, 10)}${credit(p.check.by)}` : "tested against a mock of its API only",
    ],
    [
      "Cold start",
      lb?.medianCreateMs ? `${lb.medianCreateMs.toLocaleString("en-US")} ms` : "not measured",
      lb ? `median, ${reports.length} location${reports.length === 1 ? "" : "s"}` : "no benchmark run yet",
    ],
    ["Succeeded", lb ? `${Math.round(lb.successRate * 100)}%` : "not measured", lb ? "of benchmark sandboxes" : "no benchmark run yet"],
    [
      "Size you get",
      cost?.delivered ? `${cost.delivered.vcpu} vCPU / ${cost.delivered.memoryGb} GB` : "not measured",
      cost?.delivered ? `asked for ${cost.requested.vcpu} vCPU / ${cost.requested.memoryGb} GB` : "no cost run yet",
    ],
    [
      "Billed vs list price",
      billed ? `${Math.round((billed.usd / billed.list) * 100)}%` : cost?.error ? "run failed" : noBillingApi ? "no billing API" : "not measured",
      billed
        ? `$${billed.usd.toFixed(4)} billed, $${billed.list.toFixed(4)} at list, ${cost!.date.slice(0, 10)}${credit(cost!.by)}`
        : cost
          ? cost.date.slice(0, 10)
          : "no cost run yet",
    ],
  ];
  const help = [
    ...(p.live.status !== "passed" ? [`npx ${NPM} check --provider ${p.id} --save --by YOUR_GITHUB_USERNAME`] : []),
    ...(!lb ? [`npx ${NPM} bench --provider ${p.id} --runs 5 --share --label "your city or cloud region" --by YOUR_GITHUB_USERNAME`] : []),
    ...(!billed && !noBillingApi ? [`npx ${NPM} cost run --provider ${p.id} --minutes 10 --by YOUR_GITHUB_USERNAME`] : []),
  ];

  return (
    <div className="px-5 sm:px-10 pt-12">
      <Link href="/#providers" className="text-[13px] text-muted hover:text-ink">
        ← Providers
      </Link>
      <h1 className="mt-8 text-4xl font-normal tracking-[-0.035em]">{p.name}</h1>
      <p className="mt-2 font-mono text-[12px] text-muted">provider: &quot;{p.id}&quot;</p>
      {p.access && (
        <p className="mt-5 max-w-2xl border-l-2 border-line-2 pl-3 text-[14px] leading-6 text-ink">
          {p.access.status === "waitlist" ? "Sign-up is waitlisted" : "Not taking new accounts"}: {p.access.note}. Checked {p.access.checked}.
        </p>
      )}
      {p.pricing.note && <p className="mt-5 max-w-2xl text-[14px] leading-6 text-ink-2">{p.pricing.note[0].toUpperCase() + p.pricing.note.slice(1)}.</p>}
      {p.defaultSize && (
        <p className="mt-3 max-w-2xl border-l-2 border-accent pl-3 text-[14px] leading-6 text-ink">
          Its default image runs at {p.defaultSize.vcpu} vCPU / {p.defaultSize.memoryGb} GB whatever size you ask for, measured inside
          real sandboxes. The router only sends it work that fits, and prices it at that size. For more, pass your own image as{" "}
          <code className="font-mono text-[12.5px]">image.{p.id}</code>.
        </p>
      )}

      <div className="mt-12 grid grid-cols-1 gap-12 md:grid-cols-2">
        <section>
          <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">List price per hour</h2>
          <table className="mt-4 w-full text-[13px]">
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
          <p className="mt-4 text-[12px] leading-5 text-muted">
            From{" "}
            <a href={p.pricing.source} className="underline decoration-line-2 underline-offset-2 hover:text-ink">
              {p.pricing.source.replace("https://", "")}
            </a>
            , checked {p.pricing.checked}. An estimate of what you&apos;ll pay, not a bill (
            <Link href="/#sources" className="underline decoration-line-2 underline-offset-2 hover:text-ink">
              where the numbers come from
            </Link>
            ).
          </p>
          {!p.local && (
            <p className="mt-2 text-[12px] leading-5 text-muted">
              {p.billing === "active-cpu"
                ? "CPU is billed only while busy, so these are the prices with every core busy; idle time costs less. "
                : "Billed on the size you ask for while it runs. "}
              Plan needed: {p.planLabel}
              {p.plan ? ` (${p.plan.note}; checked ${p.plan.checked})` : " (a free tier or pay-as-you-go works)"}.
            </p>
          )}
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
          <dl className="mt-4 grid grid-cols-2 gap-px border border-line bg-line sm:grid-cols-3 lg:grid-cols-5">
            {facts.map(([k, v, sub]) => (
              <div key={k} className="bg-bg p-4">
                <dt className="text-[11px] uppercase tracking-[0.12em] text-muted">{k}</dt>
                <dd className={`mt-2 font-mono text-[15px] tnum ${/^(not |no |run failed)/.test(v) ? "text-muted" : "text-ink"}`}>{v}</dd>
                <dd className="mt-1 text-[12px] leading-5 text-muted">{sub}</dd>
              </div>
            ))}
          </dl>
          {help.length > 0 && (
            <div className="mt-6 border-l-2 border-accent pl-4">
              <h3 className="text-[15px] text-ink">Help verify {p.name}</h3>
              <p className="mt-2 max-w-2xl text-[13px] leading-6 text-ink-2">
                Have a {p.name} account? These run real sandboxes on it, for a few cents at most, and write result files that fill in
                the blanks above. Results never include your keys.
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

      <section className="mt-12">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">Real-account check, step by step</h2>
        {p.check ? (
          <>
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
          </>
        ) : (
          <p className="mt-4 max-w-2xl text-[13px] leading-6 text-ink-2">
            Not run against a real account yet. The adapter is tested against a mock of {p.name}&apos;s API; this fills in when someone runs{" "}
            <code className="font-mono text-[12px]">sandboxrouter check --provider {p.id} --save</code> with real keys.
          </p>
        )}
      </section>

      <div className="mt-12 grid grid-cols-1 gap-4">
        <CodeBlock title="setup" code={setup} />
        <CodeBlock title={`use ${p.name}`} code={code} />
      </div>
    </div>
  );
}
