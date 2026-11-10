import { Button, SectionTitle } from "@/components/chrome";
import { CodeTabs, InstallChip } from "@/components/code";
import { ProviderTable } from "@/components/ProviderTable";
import { Sources } from "@/components/Sources";
import { DesktopTable } from "@/components/DesktopTable";
import { RouteDemo } from "@/components/RouteDemo";
import { HOSTED_FEE_PCT, HOSTED_URL, NPM, NPM_URL, REPO, REPO_PUBLIC, site } from "@/lib/site";

const TS = `import { Router } from "${NPM}";

const router = new Router();      // uses whichever provider keys you've set
const sbx = await router.create();

const r = await sbx.exec("python3 -c 'print(6*7)'");
console.log(r.stdout, sbx.provider);
await sbx.kill();`;

const PY = `from sandboxrouter import Client

sr = Client("http://127.0.0.1:8787", token="...")
with sr.create() as sbx:
    print(sbx.exec("python3 -c 'print(6*7)'").stdout, sbx.provider)`;

const HTTP = `curl localhost:8787/v1/sandboxes \\
  -H "Authorization: Bearer $SANDBOXROUTER_TOKEN" \\
  -d '{}'`;

const STEPS = [
  [
    "Set your keys",
    "Add the API keys of the providers you already use, one or thirty, and the router only ever uses those accounts. Or skip them all with one hosted sandboxrouter key.",
  ],
  [
    "create() picks a provider",
    "Providers that passed our real-account test go first, cheapest first by public list price, then the untested ones. If one is down, busy or out of credit, the next takes the sandbox, and every attempt is on sbx.attempts. No provider pays for placement.",
  ],
  [
    "Same sandbox everywhere",
    "Run commands, stream output, move files, pause. The sandbox stays on that provider until you kill it; if a script crashes first, sandboxrouter gc kills what it left behind.",
  ],
];

export default function Home() {
  const cloud = site.providers.filter((p) => !p.local).length;
  const passed = site.providers.filter((p) => !p.local && p.live.status === "passed").length;
  return (
    <div className="px-5 sm:px-10">
      <div className="grid items-center gap-12 pt-16 pb-6 sm:pt-24 lg:grid-cols-2 lg:gap-16">
      <section>
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">
          Open source · {cloud} providers · <span className="text-accent">{passed} passing on real accounts</span>
        </p>
        <h1 className="mt-5 max-w-2xl text-4xl font-normal leading-[1.08] tracking-[-0.035em] sm:text-[52px]">
          One API for <span className="text-accent">every sandbox.</span>
        </h1>
        <p className="mt-5 max-w-xl text-[15px] leading-7 text-ink-2">
          AI agents need a safe computer to run code. sandboxrouter starts it on the cheapest tested provider you have keys for,
          and moves to the next one if that provider is down, busy or out of credit. One interface for {cloud} providers, plus Docker on
          your own machine. Bring your own provider keys for free, or use one hosted key with prepaid credit.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <InstallChip cmd={`npm i ${NPM}`} />
          <Button href={`${HOSTED_URL}/dashboard`} primary>
            Get a key
          </Button>
          <Button href="/docs">Docs</Button>
          <Button href={REPO_PUBLIC ? REPO : NPM_URL}>{REPO_PUBLIC ? "GitHub" : "npm"}</Button>
        </div>
      </section>

      <div className="min-w-0 space-y-4">
        <CodeTabs
          tabs={[
            { label: "TypeScript", code: TS },
            { label: "Python", code: PY },
            { label: "HTTP", code: HTTP },
          ]}
        />
        <RouteDemo />
      </div>
      </div>

      <section className="mt-20">
        <SectionTitle id="how" kicker="How it works">
          Pick a provider when the sandbox starts
        </SectionTitle>
        <ol className="mt-8 grid gap-10 sm:grid-cols-3">
          {STEPS.map(([title, body], i) => (
            <li key={title}>
              <span className="font-mono text-[13px] text-accent">0{i + 1}</span>
              <h3 className="mt-2 text-[16px] text-ink">{title}</h3>
              <p className="mt-2 text-[14px] leading-6 text-ink-2">{body}</p>
            </li>
          ))}
        </ol>
        <p className="mt-10 max-w-3xl border-l-2 border-accent pl-4 text-[15px] leading-7 text-ink-2">
          <span className="text-ink">Built for anything that starts many short-lived sandboxes:</span> agents that open one per task
          or per user, evals, and RL rollouts. Each new sandbox goes to the cheapest tested provider that&apos;s up, and switching providers is
          a matter of which keys are set, not a rewrite. Free and MIT licensed.
        </p>
      </section>

      <section className="mt-24">
        <SectionTitle id="hosted" kicker="Pricing">
          Your keys, or ours
        </SectionTitle>
        <div className="mt-8 grid border border-line sm:grid-cols-2">
          {[
            {
              title: "Self-hosted",
              price: "Free",
              unit: "MIT licensed",
              points: [
                "Use the provider accounts you already have",
                "You pay each provider directly, at their price",
                "Run it in your code, or as an HTTP server with sandboxrouter serve",
              ],
              cta: { href: "/docs#quickstart", label: "Quickstart" },
            },
            {
              title: "Hosted key",
              price: `List price + ${HOSTED_FEE_PCT}%`,
              unit: "billed by the second",
              points: [
                "One sandboxrouter API key, no provider accounts",
                "Prepaid credit by card; sandboxes stop when it runs out",
                "Agents can sign up through the API and hand their person a payment link",
              ],
              cta: { href: `${HOSTED_URL}/dashboard`, label: "Get a key" },
              primary: true,
            },
          ].map((plan, i) => (
            <div key={plan.title} className={`flex flex-col p-6 ${i ? "border-t border-line sm:border-t-0 sm:border-l" : ""}`}>
              <h3 className="text-[15px] text-ink">{plan.title}</h3>
              <p className="mt-3 text-2xl tracking-[-0.025em]">
                {plan.price} <span className="text-[13px] text-muted">{plan.unit}</span>
              </p>
              <ul className="mt-4 flex-1 space-y-2 text-[14px] leading-6 text-ink-2">
                {plan.points.map((pt) => (
                  <li key={pt} className="flex gap-2">
                    <span className="text-accent">›</span>
                    {pt}
                  </li>
                ))}
              </ul>
              <div className="mt-6">
                <Button href={plan.cta.href} primary={plan.primary}>
                  {plan.cta.label}
                </Button>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-4 text-[13px] text-muted">
          Both use the same router and the same API. Moving between them changes the base URL and the key, not your code.
        </p>
      </section>

      <section className="mt-24">
        <SectionTitle id="providers" kicker="Providers">
          What a sandbox costs, everywhere
        </SectionTitle>
        <div className="mt-6">
          <ProviderTable />
        </div>
        <div className="mt-12">
          <Sources />
        </div>
      </section>

      <section className="mt-24">
        <SectionTitle id="desktops" kicker="Desktops & phones">
          Computers your model can see and click
        </SectionTitle>
        <div className="mt-6">
          <DesktopTable />
        </div>
      </section>

    </div>
  );
}
