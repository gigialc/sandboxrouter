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
              ["Routing", p.local ? "Only when you ask for it by name" : "Chosen when it's the cheapest fit, or as a fallback"],
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

      <div className="mt-12 grid gap-4">
        <CodeBlock title="setup" code={setup} />
        <CodeBlock title={`use ${p.name}`} code={code} />
      </div>
    </div>
  );
}
