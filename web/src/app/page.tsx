import { Button, SectionTitle } from "@/components/chrome";
import { CodeTabs, InstallChip } from "@/components/code";
import { ProviderTable } from "@/components/ProviderTable";
import { DesktopTable } from "@/components/DesktopTable";
import { NPM, NPM_URL, REPO, REPO_PUBLIC, site } from "@/lib/site";

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

const RULES = [
  ["Cheapest first", "With no other instruction, a sandbox goes to the lowest list price for its size among the providers you have keys for. Ties go alphabetically. No provider pays for placement."],
  ["Falls back", "If a provider is busy or down, the next one takes the sandbox. Every attempt is on sbx.attempts."],
  ["Your keys", "Bring your own accounts. Nothing is proxied through anyone else. Free and MIT licensed."],
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
          AI agents need a safe computer to run code. sandboxrouter starts it on whichever provider fits the job, and moves to the
          next one if that provider is busy. One interface for {cloud} providers, plus Docker on your own machine.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <InstallChip cmd={`npm i ${NPM}`} />
          <Button href="/docs" primary>
            Docs
          </Button>
          <Button href={REPO_PUBLIC ? REPO : NPM_URL}>{REPO_PUBLIC ? "GitHub" : "npm"}</Button>
        </div>
      </section>

      <div className="min-w-0">
        <CodeTabs
          tabs={[
            { label: "TypeScript", code: TS },
            { label: "Python", code: PY },
            { label: "HTTP", code: HTTP },
          ]}
        />
      </div>
      </div>

      <section className="mt-24">
        <SectionTitle id="providers" kicker="Providers">
          What a sandbox costs, everywhere
        </SectionTitle>
        <div className="mt-6">
          <ProviderTable />
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

      <section className="mt-24 grid gap-10 border-t border-line pt-10 sm:grid-cols-3">
        {RULES.map(([t, b]) => (
          <div key={t}>
            <h3 className="text-[15px] text-ink">{t}</h3>
            <p className="mt-2 text-[13px] leading-6 text-ink-2">{b}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
