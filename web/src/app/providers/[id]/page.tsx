import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CodeBlock } from "@/components/code";
import { CAPABILITY_LABEL, NPM, PACKAGE, provider, shapeLabel, site, usd } from "@/lib/site";

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

      <div className="mt-12 grid gap-12 md:grid-cols-2">
        <section>
          <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">Price per hour</h2>
          <table className="mt-4 w-full text-[13px]">
            <tbody>
              {site.shapes.map((s) => (
                <tr key={s} className="border-t border-line">
                  <td className="py-2.5 text-ink-2 tnum">{shapeLabel(s)}</td>
                  <td className="py-2.5 text-right font-mono tnum">
                    {p.prices[s].unfit ? <span className="text-muted">{p.prices[s].unfit}</span> : usd(p.prices[s].usd)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-4 text-[12px] text-muted">
            Source:{" "}
            <a href={p.pricing.source} className="underline decoration-line-2 underline-offset-2 hover:text-ink">
              {p.pricing.source.replace("https://", "")}
            </a>
            , checked {p.pricing.checked}.
          </p>
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

      <section className="mt-12">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">Real-account check</h2>
        {p.check ? (
          <>
            <p className="mt-4 text-[13px] text-ink-2">
              {p.check.passed} of {site.checkSteps.length - p.check.skipped.length} steps passed on a real account, {p.check.date.slice(0, 10)} (v
              {p.check.version}).
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

      <div className="mt-12 grid gap-4">
        <CodeBlock title="setup" code={setup} />
        <CodeBlock title={`use ${p.name}`} code={code} />
      </div>
    </div>
  );
}
