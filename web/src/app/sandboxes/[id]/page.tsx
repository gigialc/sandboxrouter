import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/chrome";
import { CodeBlock } from "@/components/code";
import { CAPABILITY_LABEL, PACKAGE, provider, shapeLabel, site, usd } from "@/lib/site";

const NOTES: Record<string, string> = {
  maritime: "Plain REST, no SDK to install. Streams output over SSE. Any data-plane call resumes a paused sandbox. Also sells Linux and Windows desktops and Android phones on the same key.",
  e2b: "vCPU and memory come from the template, not the create call. Pause snapshots memory and disk.",
  daytona: "Sizing applies when you start from an image. Pause stops the sandbox and keeps its disk.",
  modal: "The only adapter that takes a GPU today. Uses a Modal app named sandboxrouter.",
  vercel: "Memory is fixed at 2 GB per vCPU, up to 8 vCPU. Bills active CPU only.",
  morph: "The first sandbox of a new size builds a cached base snapshot. Pause keeps memory and disk.",
  sprites: "Sprites idle for free on their own and have no lifetime setting; kill() deletes the sprite. Its SDK asks for Node 24+.",
  blaxel: "Billed on memory; CPU follows memory. Idle sandboxes drop to a free standby on their own.",
  tensorlake: "Pause keeps memory and disk. The lifetime is an idle timeout.",
  runloop: "Sizes snap to Runloop's custom sizes. Suspend/resume needs the Pro plan.",
};

export function generateStaticParams() {
  return site.providers.map((p) => ({ id: p.id }));
}

export async function generateMetadata({ params }: PageProps<"/sandboxes/[id]">): Promise<Metadata> {
  const { id } = await params;
  const p = provider(id);
  return { title: p ? `${p.name} sandboxes` : "Not found" };
}

export default async function ProviderPage({ params }: PageProps<"/sandboxes/[id]">) {
  const { id } = await params;
  const p = provider(id);
  if (!p) notFound();

  const pkg = PACKAGE[p.id];
  const install = pkg ? `npm i @sandboxrouter/sdk ${pkg}` : "npm i @sandboxrouter/sdk";
  const env = p.credentials.map((g) => g.map((k) => `export ${k}=...`).join("\n")).join("\n# or\n");
  const code = `import { Router } from "@sandboxrouter/sdk";

const router = new Router();
const sbx = await router.create({ vcpu: 2, memoryGb: 4 }, { provider: "${p.id}" });
const r = await sbx.exec("uname -a", { onStdout: (c) => process.stdout.write(c) });
await sbx.kill();`;
  const caps = [...p.capabilities, ...(p.computers.length ? ["computers"] : [])];

  return (
    <div className="mx-auto max-w-6xl px-5 pt-10">
      <Link href="/sandboxes" className="text-sm text-muted hover:text-ink">
        ← Sandboxes
      </Link>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <h1 className="text-4xl font-semibold tracking-tight">{p.name}</h1>
        {p.order === 0 && <Badge tone="accent">default route</Badge>}
      </div>
      <p className="mt-2 font-mono text-sm text-muted">provider: &quot;{p.id}&quot;</p>
      <p className="mt-5 max-w-2xl text-ink-2">{NOTES[p.id]}</p>

      <div className="mt-10 grid gap-8 lg:grid-cols-[1.1fr_1fr]">
        <section className="rounded-xl border border-line ">
          <h2 className="border-b border-line px-5 py-3 text-sm font-medium">Price per hour while running</h2>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-line">
              {site.shapes.map((s) => (
                <tr key={s}>
                  <td className="px-5 py-3 text-ink-2 tnum">{shapeLabel(s)}</td>
                  <td className="px-5 py-3 text-right font-mono tnum">
                    {p.prices[s].unfit ? <span className="text-muted">{p.prices[s].unfit}</span> : usd(p.prices[s].usd)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="border-t border-line px-5 py-4 text-xs leading-5 text-muted">
            {p.pricing.note && <p>{p.pricing.note}.</p>}
            <p className="mt-1">
              Source:{" "}
              <a href={p.pricing.source} className="underline underline-offset-2">
                {p.pricing.source.replace("https://", "")}
              </a>
              , checked {p.pricing.checked}.
            </p>
          </div>
        </section>

        <section className="space-y-6">
          <div className="rounded-xl border border-line p-5">
            <h2 className="text-sm font-medium">What the adapter supports</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              <Badge>exec + streaming</Badge>
              <Badge>files</Badge>
              {caps.map((c) => (
                <Badge key={c}>{CAPABILITY_LABEL[c] ?? c}</Badge>
              ))}
            </div>
            <dl className="mt-5 grid grid-cols-2 gap-4 text-sm">
              <div>
                <dt className="text-muted">Max size</dt>
                <dd className="mt-1 font-mono tnum">
                  {p.limits.maxVcpu} vCPU · {p.limits.maxMemoryGb} GB
                </dd>
              </div>
              <div>
                <dt className="text-muted">Provider docs</dt>
                <dd className="mt-1">
                  <a href={p.docs} className="underline underline-offset-2">
                    {new URL(p.docs).hostname}
                  </a>
                </dd>
              </div>
              {p.computers.length > 0 && (
                <div className="col-span-2">
                  <dt className="text-muted">Computers</dt>
                  <dd className="mt-1">{p.computers.join(", ")}</dd>
                </div>
              )}
            </dl>
          </div>
          <CodeBlock title="install" code={`${install}\n${env}`} />
        </section>
      </div>

      <section className="mt-8">
        <CodeBlock title={`use ${p.name}`} code={code} />
        <p className="mt-3 text-sm text-muted">
          Leave out <span className="font-mono">provider</span> and the router picks {p.name} whenever it&apos;s the best fit for the
          job, or falls back to it when another provider is busy.
        </p>
      </section>
    </div>
  );
}
