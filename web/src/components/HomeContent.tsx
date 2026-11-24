import type { Metadata } from "next";
import Link from "next/link";
import { ORIGIN, pageAlternates } from "@/lib/public-pages";
import { Button } from "@/components/chrome";
import { ConditionalStartFeeNote, hasStartFee } from "@/components/ConditionalStartFeeNote";
import { CodeBlock, CodeTabs, InstallChip } from "@/components/code";
import { Feature } from "@/components/Feature";
import { PriceIndex } from "@/components/PriceIndex";
import { ProviderLogo } from "@/components/ProviderName";
import { BarNum, ResultRow, ResultTable, Num, barMax, money, time } from "@/components/results";
import { RouteDemo } from "@/components/RouteDemo";
import { HOSTED_FEE_PCT, HOSTED_PUBLIC, HOSTED_URL, NPM, NPM_URL, OWN_IMAGE_NOTE, REPO, REPO_PUBLIC, needsOwnImage, site, sizeNote } from "@/lib/site";

export const metadata: Metadata = { alternates: pageAlternates("/") };

const product = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "@id": `${ORIGIN}/#software`,
  name: "SandboxRouter",
  url: ORIGIN,
  description: "An open-source API, SDK, and CLI for routing AI agent sandboxes across providers, with public pricing and benchmarks.",
  applicationCategory: "DeveloperApplication",
  keywords: ["sandbox API", "AI agent sandboxes", "sandbox provider benchmarks"],
  sameAs: [REPO, NPM_URL],
  offers: { "@type": "Offer", name: "Open-source SDK", url: NPM_URL, price: 0, priceCurrency: "USD" },
};

const OWN_KEYS = `import { Router } from "${NPM}";

// uses whichever provider keys you've set
const sbx = await new Router().create();
console.log((await sbx.exec("echo hi")).stdout, sbx.provider);
await sbx.kill();`;

const HOSTED = `import { Client } from "${NPM}";

const sr = new Client({
  baseUrl: "${HOSTED_URL}",
  apiKey: process.env.SANDBOXROUTER_API_KEY,
});
const sbx = await sr.create();
console.log((await sbx.exec("echo hi")).stdout, sbx.provider);
await sbx.kill();`;

const HTTP = `curl ${HOSTED_URL}/v1/sandboxes \\
  -H "Authorization: Bearer $SANDBOXROUTER_API_KEY" -d '{}'`;

/** Everything the homepage says. The front page shows it under the storm. */
export function HomeContent() {
  const cloud = site.providers.filter((p) => !p.local);
  const passed = cloud.filter((p) => p.live.status === "passed");
  // The same list the Providers page's desktop table shows.
  const desktops = site.desktops.length;
  // Prefer tested providers in the hero strip, with Vercel in the former Sprites slot.
  const short = (n: string) => n.replace(/ \(.*\)$/, "");
  const stripOrder = [...passed, ...cloud.filter((p) => p.live.status !== "passed").sort((a, b) => a.name.localeCompare(b.name))]
    .filter((p) => short(p.name).length <= 14);
  const spritesIndex = stripOrder.findIndex((p) => p.id === "sprites");
  const vercelIndex = stripOrder.findIndex((p) => p.id === "vercel");
  if (spritesIndex >= 0 && vercelIndex > spritesIndex) {
    [stripOrder[spritesIndex], stripOrder[vercelIndex]] = [stripOrder[vercelIndex], stripOrder[spritesIndex]];
  }
  const strip = stripOrder.filter((p) => p.id !== "sprites").slice(0, 9);
  // The benchmarks section quotes the short job: who finished first, and who cost least.
  const short_ = site.tasks.kinds.find((k) => k.id === "short");
  const scale = site.scale;
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const fastest = short_ && [...short_.rows].sort((a, b) => a.taskMs - b.taskMs)[0];
  // Cost per successful run, like the Real jobs tab and the finder.
  const perOk = (r: { taskUsd: number; successRate: number }) => r.taskUsd / Math.max(r.successRate, 0.01);
  const shortByCost = [...(short_?.rows ?? [])].sort((a, b) => perOk(a) - perOk(b));
  const cheapestTask = shortByCost[0];
  const shortRows = shortByCost.slice(0, 6);

  return (
    <div className="px-5 sm:px-10">
      <section className="flex flex-col items-center gap-[clamp(0.875rem,2.75svh,1.5rem)] pt-[clamp(1.25rem,5svh,2.5rem)] pb-10 text-center sm:gap-[clamp(1rem,4.25svh,2.5rem)] sm:pt-[clamp(1.5rem,calc(16svh_-_4.5rem),5rem)] sm:pb-14">
        <h1 className="text-[clamp(1.875rem,min(calc(1rem_+_4.5vw),8.75svh),4rem)] font-normal leading-[1.08] tracking-[-0.04em] text-balance">
          One API for every sandbox.
          <br />
          <span className="text-muted">Find a provider that fits.</span>
        </h1>
        <div className="flex flex-wrap justify-center gap-3">
          {HOSTED_PUBLIC ? (
            <Button href={`${HOSTED_URL}/dashboard`} primary>
              Get a key
            </Button>
          ) : (
            <Button href="/docs#quickstart" primary>
              Quickstart
            </Button>
          )}
          {REPO_PUBLIC ? <Button href={REPO}>GitHub</Button> : <Button href="/docs">Docs</Button>}
        </div>

        <p className="max-w-lg text-[15px] leading-6 text-ink-2 sm:leading-7">
          The SDK prioritises providers by estimated cost and can try another if a start fails.{" "}
          {HOSTED_PUBLIC ? "Open source, or one hosted key." : "Open source."}{" "}
          <Link href="/learn" className="text-ink underline underline-offset-4 decoration-line-2 hover:decoration-ink">
            New to sandboxes?
          </Link>
        </p>
        <div className="flex w-full max-w-xl flex-col items-center gap-3">
          <InstallChip cmd={`npm i ${NPM}`} />
          <div className="w-full text-left">
            <CodeBlock title="index.ts" code={OWN_KEYS} wrap />
          </div>
        </div>
      </section>

      <div className="overflow-hidden border-y border-line py-6">
        <ul className="flex flex-wrap items-center justify-center gap-x-8 gap-y-4 text-[14px] text-ink-2">
          {strip.map((p) => (
            <li key={p.id}>
              <Link href={`/providers/${p.id}`} className="inline-flex items-center gap-2 hover:text-ink">
                <ProviderLogo id={p.id} name={p.name} size={22} />
                {short(p.name)}
              </Link>
            </li>
          ))}
          <li>
            <Link href="/providers" className="text-ink-2 hover:text-ink">
              +{cloud.length - strip.length} more
            </Link>
          </li>
        </ul>
      </div>

      <div className="mx-auto mt-24 max-w-[1320px] space-y-24 sm:mt-28 sm:space-y-32">
        <Feature
          label="Route"
          claim="Route by estimated cost, speed or capability."
          actions={
            <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(product).replace(/</g, "\\u003c") }} />
              <Button href="/docs#routing" primary>
                How routing works
              </Button>
              <Button href="/playground">Local playground</Button>
            </>
          }
          points={[
            {
              title: "Fallback when starting",
              body: "Out of credit, rate-limited or down: if a provider can't start your sandbox, the next one does, and every attempt is on sbx.attempts. Once it's running, it stays where it started.",
            },
            { title: "One handle, whatever ran it", body: "Run commands and move files through one API. Stream output or pause where the provider supports it." },
            { title: "The provider's own SDK is still there", body: "sbx.native is the provider's own sandbox object, already connected, for ports, snapshots and anything the router doesn't cover." },
            { title: "Recover after a crash", body: "Run sandboxrouter gc to try to stop expired sandboxes recorded by the SDK. It reports any cleanup failures." },
          ]}
          visual={<RouteDemo />}
        />

        {scale && (
          <Feature
            id="scale"
            flip
            label="At scale"
            claim="If a provider can't start your sandbox, the next one does."
            actions={
              <>
                {HOSTED_PUBLIC ? (
                  <Button href={`${HOSTED_URL}/dashboard`} primary>
                    Get a key
                  </Button>
                ) : (
                  <Button href="/docs#quickstart" primary>
                    Quickstart
                  </Button>
                )}
                <Button href="/docs#cooldowns">How failover works</Button>
              </>
            }
            points={[
              {
                title: "A burst across providers",
                body: `On ${day(scale.date)}, ${scale.byProvider.length} providers in our ${scale.poolSize}-provider test pool started ${scale.ok.toLocaleString("en-US")} of ${scale.n.toLocaleString("en-US")} requested sandboxes. The test took ${time(scale.wallMs)} using our provider accounts.`,
              },
              {
                title: "Failover when starting, that remembers",
                body: `A provider that rate-limits you goes to the back of the line for 30 seconds; one that keeps failing to start sandboxes, for a minute. New sandboxes stop waiting on it, and one success brings it back. A sandbox that's already running stays on its provider; if that provider fails mid-run, the work isn't moved.`,
              },
              {
                title: "Account limits",
                body: "Capacity varies by provider account and plan. The hosted API has its own per-account concurrency limit.",
              },
            ]}
            visual={<ScaleChart scale={scale} day={day} />}
          />
        )}

        {short_ && fastest && cheapestTask && (
          <Feature
            label="Benchmarks"
            claim="Compare the same job across tested providers."
            actions={
              <>
                <Button href="/benchmarks#task" primary>
                  See the results
                </Button>
                <Button href="/benchmarks">All benchmarks</Button>
              </>
            }
            points={[
              {
                title: "The fastest isn't the cheapest",
                body: `On the short job, ${cheapestTask.name} had the lowest estimated cost before account-specific fees, at $${(perOk(cheapestTask) * 1000).toFixed(3)} per 1,000 successful runs. ${fastest.name} finished fastest after startup (${time(fastest.taskMs)}) and ranks #${shortByCost.findIndex((r) => r.provider === fastest.provider) + 1} of ${shortByCost.length} on cost.`,
              },
              {
                title: "Real jobs, real accounts",
                body: `We measured the short job on real accounts. ${short_.rows.length} providers completed it. The benchmarks also cover starts under load, Python jobs, repo setup and an agent session.`,
              },
              {
                title: "Estimated costs",
                body: "Estimates apply modelled minimums and start fees to measured times. Extra fees that depend on your provider account can change the ranking.",
              },
            ]}
            visual={
              <div className="overflow-x-auto border border-line p-5 sm:p-8">
                <p className="text-[12px] uppercase tracking-[0.12em] text-muted">{short_.title} · cheapest first</p>
                <ResultTable cols={[{ label: "Est. / 1,000 runs" }, { label: "Time incl. start", className: "hidden sm:table-cell" }]}>
                  {shortRows.map((r, k) => (
                    <ResultRow
                      key={r.provider}
                      rank={k + 1}
                      id={r.provider}
                      name={r.name.replace(/ \(.*\)$/, "")}
                      notes={[sizeNote(r.size), needsOwnImage(r.provider, r.size) ? OWN_IMAGE_NOTE : ""].filter(Boolean)}
                    >
                      <BarNum value={perOk(r)} max={barMax(shortRows.map(perOk))}>
                        {money(perOk(r) * 1000)}
                      </BarNum>
                      <Num className="hidden sm:table-cell">{time(r.createMs + r.taskMs)}</Num>
                    </ResultRow>
                  ))}
                </ResultTable>
                {hasStartFee(shortRows.map((r) => r.provider)) && (
                  <p className="mt-3 text-[12px] leading-5 text-muted"><ConditionalStartFeeNote ids={shortRows.map((r) => r.provider)} /></p>
                )}
              </div>
            }
          />
        )}

        <Feature
          flip
          label="Price"
          claim="Every provider's list price, side by side, at the size you ask for."
          actions={
            <>
              <Button href="/providers" primary>
                All {cloud.length} providers
              </Button>
              <Button href="/benchmarks">Benchmarks</Button>
            </>
          }
          points={[
            { title: "Tested on real accounts", body: `${passed.length} providers pass our real-account check. Ones that fail it are tried last.` },
            { title: "No paid placement", body: "Order comes from price and test results only. No provider pays for its position." },
            { title: "Desktops and phones too", body: `Computers your model can see and click, from ${desktops} providers.` },
          ]}
          visual={
            <div className="border border-line p-5 sm:p-8">
              <PriceIndex />
            </div>
          }
        />

        {HOSTED_PUBLIC && (
        <Feature
          id="hosted"
          label="Pricing"
          claim="The same code with your own provider keys, or with one sandboxRouter key."
          actions={
            <>
              <Button href={`${HOSTED_URL}/dashboard`} primary>
                Get a key
              </Button>
              <Button href={`${HOSTED_URL}/providers`}>Hosted providers</Button>
            </>
          }
          points={[
            { title: "Your keys: free", body: "MIT licensed. Sandboxes run on your provider accounts and you pay each provider directly." },
            { title: `Hosted rates + ${HOSTED_FEE_PCT}%`, body: "The hosted key uses our configured providers. Charges use estimated provider compute rates, with minimums, billing increments and modelled start fees where applicable. Sandboxes stop when credit runs out." },
            { title: "Agents can sign up themselves", body: "POST /v1/signup returns a key; the agent hands its person a link to pay." },
          ]}
          visual={
            <CodeTabs
              tabs={[
                { label: "One key", code: HOSTED },
                { label: "Your keys", code: OWN_KEYS },
                { label: "HTTP", code: HTTP },
              ]}
            />
          }
        />
        )}
      </div>

      <section className="mt-40 flex flex-col items-center border-t border-line pt-24 text-center">
        <h2 className="text-[32px] font-normal tracking-[-0.03em] sm:text-[40px]">Start a sandbox in a minute.</h2>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          {HOSTED_PUBLIC ? (
            <Button href={`${HOSTED_URL}/dashboard`} primary>
              Get a key
            </Button>
          ) : (
            <Button href="/docs#quickstart" primary>
              Quickstart
            </Button>
          )}
          {HOSTED_PUBLIC ? <Button href="/docs#quickstart">Quickstart</Button> : REPO_PUBLIC && <Button href={REPO}>GitHub</Button>}
        </div>
      </section>
    </div>
  );
}

/** Where the sandboxes of the spread burst ran: one bar per provider, out of the whole burst. */
function ScaleChart({ scale, day }: { scale: NonNullable<typeof site.scale>; day: (iso: string) => string }) {
  const max = Math.max(...scale.byProvider.map((b) => b.ok), 1);
  return (
    <figure className="border border-line p-5 sm:p-8">
      <p className="text-[12px] uppercase tracking-[0.12em] text-muted">
        {scale.n.toLocaleString("en-US")} concurrent requests, {day(scale.date)} · where they ran
      </p>
      <ul className="mt-5 space-y-2.5">
        {scale.byProvider.map((b) => (
          <li key={b.provider} className="grid grid-cols-[minmax(0,10rem)_1fr_3.5rem] items-center gap-3 text-[13px]">
            <span className="flex min-w-0 items-center gap-2 text-ink-2">
              <ProviderLogo id={b.provider} name={b.name} size={18} />
              <span className="truncate">{b.name.replace(/ (Sandbox|Sandboxes|AI Agent Sandbox|Code Interpreter)$/, "").replace("Amazon Bedrock ", "")}</span>
            </span>
            <span className="h-[6px] bg-line" aria-hidden>
              <span className="block h-[6px] bg-bar" style={{ width: `${(b.ok / max) * 100}%` }} />
            </span>
            <span className="text-right font-mono tnum text-ink">{b.ok}</span>
          </li>
        ))}
      </ul>
      <figcaption className="mt-5 border-t border-line pt-4 text-[13px] leading-5 text-ink-2">
        <span className="font-mono text-ink tnum">
          {scale.ok.toLocaleString("en-US")}/{scale.n.toLocaleString("en-US")}
        </span>{" "}
        answered a command across {scale.byProvider.length} of {scale.poolSize} providers in our test pool.
        {scale.bestSingle ? (
          <>
            {" "}
            In standalone tests at the same burst size, {scale.bestSingle.name} had the most starts
            ({scale.bestSingle.ok.toLocaleString("en-US")} of {scale.n.toLocaleString("en-US")}, across {scale.standaloneProviders} providers tested).
          </>
        ) : null}{" "}
        <span className="text-muted">The test killed each sandbox after its first command. Peak live concurrency was unmeasured.</span>
        <span className="mt-2 block text-muted">A running sandbox stays on its original provider.</span>
      </figcaption>
    </figure>
  );
}
