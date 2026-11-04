import Link from "next/link";
import { Badge } from "@/components/chrome";
import { CodeTabs } from "@/components/code";
import { RouteDiagram } from "@/components/RouteDiagram";
import { DEFAULT_SHAPE, cheapest, site, usd } from "@/lib/site";

const TS = `import { Router } from "sandboxrouter";

const router = new Router();          // reads provider keys from env
const sbx = await router.create({ vcpu: 2, memoryGb: 4 });

const r = await sbx.exec("python3 -c 'print(6*7)'");
console.log(r.stdout, sbx.provider);  // 42 maritime
await sbx.kill();`;

const PY = `from sandboxrouter import Client

sr = Client("http://127.0.0.1:8787", token="...")
with sr.create(vcpu=2, memory_gb=4, strategy="cheapest") as sbx:
    print(sbx.exec("python3 -c 'print(6*7)'").stdout, sbx.provider)`;

const CURL = `curl localhost:8787/v1/sandboxes \\
  -H "Authorization: Bearer $SANDBOXROUTER_TOKEN" \\
  -d '{"vcpu": 2, "memoryGb": 4, "strategy": "cheapest"}'
# {"id":"maritime:sbx-k3m7q2ab","provider":"maritime","estimatedHourlyUsd":0.022}`;

const FEATURES = [
  {
    title: "One API",
    body: "create, exec, files, pause, kill. The same five calls on every provider, in TypeScript, Python or plain HTTP.",
  },
  {
    title: "Routing",
    body: "Send each sandbox to the cheapest provider, the fastest one you've measured, or the only one with a GPU.",
  },
  {
    title: "Automatic fallback",
    body: "If a provider is rate-limited or down, the next one takes the sandbox. Every attempt is recorded.",
  },
  {
    title: "Streaming output",
    body: "Watch stdout and stderr as they happen, on every provider, without learning ten streaming APIs.",
  },
  {
    title: "Desktops and phones",
    body: "Linux and Windows desktops and Android phones for computer-use agents, with a takeover link for logins.",
  },
  {
    title: "Your keys",
    body: "Bring your own accounts. Nothing is proxied through anyone else. MIT licensed and open source.",
  },
];

export default function Home() {
  const lo = cheapest[0].prices[DEFAULT_SHAPE].usd;
  const hi = cheapest.at(-1)!.prices[DEFAULT_SHAPE].usd;

  return (
    <>
      <section className="mx-auto grid max-w-6xl gap-12 px-5 pt-16 pb-20 *:min-w-0 lg:grid-cols-[1.05fr_1fr] lg:items-center lg:pt-24">
        <div>
          <Badge tone="accent">Open source · {site.providers.length} providers</Badge>
          <h1 className="mt-5 text-[2.6rem] font-semibold leading-[1.05] tracking-tight sm:text-6xl">
            One API for every sandbox.
          </h1>
          <p className="mt-5 max-w-xl text-lg text-ink-2">
            Your AI agent needs a safe computer to run its code. sandboxrouter starts it on the best provider for the job,
            and moves to the next one if that provider is busy. Like OpenRouter, but for sandboxes.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/docs#quickstart" className="rounded-full bg-ink px-5 py-3 text-sm font-medium text-sand hover:opacity-90">
              Get started
            </Link>
            <Link href="/sandboxes" className="rounded-full border border-line-2 px-5 py-3 text-sm font-medium hover:bg-accent-wash">
              Compare sandboxes
            </Link>
          </div>
          <div className="mt-6 font-mono text-sm text-muted">
            <span className="select-all">npm i sandboxrouter</span>
          </div>
        </div>
        <RouteDiagram />
      </section>

      <section className="border-y border-line ">
        <dl className="mx-auto grid max-w-6xl grid-cols-2 gap-px px-5 sm:grid-cols-4">
          {[
            { k: "Providers", v: String(site.providers.length) },
            { k: "Cheapest, 2 vCPU · 4 GB", v: `${usd(lo)}/hr` },
            { k: "Price spread", v: `${Math.round(hi / lo)}x` },
            { k: "License", v: "MIT" },
          ].map((s) => (
            <div key={s.k} className="py-8">
              <dt className="text-sm text-muted">{s.k}</dt>
              <dd className="mt-1 text-3xl font-semibold tracking-tight tnum">{s.v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mx-auto grid max-w-6xl gap-10 px-5 py-20 *:min-w-0 lg:grid-cols-[1fr_1.1fr] lg:items-start">
        <div>
          <h2 className="text-3xl font-semibold tracking-tight">Write it once. Run it anywhere.</h2>
          <p className="mt-4 text-ink-2">
            Set the keys for the providers you use. sandboxrouter skips the rest, explains why, and gives every sandbox a
            portable id like <code className="font-mono text-sm">maritime:sbx-k3m7q2ab</code> you can reattach to from any
            process.
          </p>
          <ul className="mt-6 space-y-3 text-sm text-ink-2">
            <li>
              <span className="font-mono text-ink">strategy: &quot;cheapest&quot;</span> sorts by list price for your machine size
            </li>
            <li>
              <span className="font-mono text-ink">strategy: &quot;fastest&quot;</span> uses cold starts you measured with{" "}
              <span className="font-mono">bench</span>
            </li>
            <li>
              <span className="font-mono text-ink">require: [&quot;pause&quot;]</span> only tries providers that can pause
            </li>
            <li>
              <span className="font-mono text-ink">fallback: false</span> turns automatic fallback off
            </li>
          </ul>
        </div>
        <CodeTabs
          tabs={[
            { label: "TypeScript", code: TS },
            { label: "Python", code: PY },
            { label: "HTTP", code: CURL },
          ]}
        />
      </section>

      <section className="mx-auto max-w-6xl px-5 pb-20">
        <div className="grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="bg-sand p-6">
              <h3 className="font-semibold">{f.title}</h3>
              <p className="mt-2 text-sm leading-6 text-ink-2">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="text-3xl font-semibold tracking-tight">Cheapest sandboxes right now</h2>
            <p className="mt-2 text-ink-2">List price per hour for 2 vCPU and 4 GB while running.</p>
          </div>
          <Link href="/sandboxes" className="shrink-0 text-sm underline underline-offset-4">
            All {site.providers.length} →
          </Link>
        </div>
        <ol className="mt-6 divide-y divide-line overflow-hidden rounded-xl border border-line ">
          {cheapest.slice(0, 5).map((p, k) => (
            <li key={p.id}>
              <Link href={`/sandboxes/${p.id}`} className="flex items-center gap-4 px-5 py-4 hover:bg-accent-wash">
                <span className="w-5 text-sm text-muted tnum">{k + 1}</span>
                <span className="font-medium">{p.name}</span>
                {k === 0 && <Badge tone="accent">default</Badge>}
                <span className="ml-auto font-mono text-sm tnum">{usd(p.prices[DEFAULT_SHAPE].usd)}/hr</span>
              </Link>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
