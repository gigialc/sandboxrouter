import Link from "next/link";
import { Button } from "@/components/chrome";
import { CodeBlock, CodeTabs, InstallChip } from "@/components/code";
import { Feature } from "@/components/Feature";
import { PriceIndex } from "@/components/PriceIndex";
import { ProviderLogo } from "@/components/ProviderName";
import { BarNum, ResultRow, ResultTable, Num, barMax, money, time } from "@/components/results";
import { RouteDemo } from "@/components/RouteDemo";
import { HOSTED_FEE_PCT, HOSTED_PUBLIC, HOSTED_URL, NPM, REPO, REPO_PUBLIC, site } from "@/lib/site";

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

export default function Home() {
  const cloud = site.providers.filter((p) => !p.local);
  const passed = cloud.filter((p) => p.live.status === "passed");
  const desktops = cloud.filter((p) => p.computers.length).length;
  // The strip under the hero: tested providers first, then the rest by name.
  const short = (n: string) => n.replace(/ \(.*\)$/, "");
  const strip = [...passed, ...cloud.filter((p) => p.live.status !== "passed").sort((a, b) => a.name.localeCompare(b.name))]
    .filter((p) => short(p.name).length <= 14)
    .slice(0, 9);
  // The benchmarks section quotes the short job: who finished first, and who cost least.
  const short_ = site.tasks.kinds.find((k) => k.id === "short");
  // Real sandboxes behind the benchmarks: the same count as the Benchmarks page.
  const totalRuns = site.submissions.reduce((n, s) => n + s.runs * s.providers, 0);
  const scale = site.scale;
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const fastest = short_ && [...short_.rows].sort((a, b) => a.taskMs - b.taskMs)[0];
  const cheapestTask = short_?.rows[0];

  return (
    <div className="px-5 sm:px-10">
      <section className="flex flex-col items-center pt-24 pb-16 text-center sm:pt-36">
        {REPO_PUBLIC && (
          <a
            href={REPO}
            className="mb-8 inline-flex items-center gap-2 whitespace-nowrap rounded-full border border-line px-3.5 py-1.5 text-[12.5px] text-ink-2 hover:border-line-2 hover:text-ink"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
            Open source, MIT licensed
            <span className="text-muted">·</span>
            <span className="text-ink">
              <span className="sm:hidden">GitHub &rarr;</span>
              <span className="hidden sm:inline">Read the code on GitHub &rarr;</span>
            </span>
          </a>
        )}
        <h1 className="text-[40px] font-normal leading-[1.08] tracking-[-0.04em] sm:text-[64px]">
          One API for every sandbox.
          <br />
          <span className="text-muted">On the cheapest one that&apos;s up.</span>
        </h1>
        <div className="mt-10 flex flex-wrap justify-center gap-3">
          {HOSTED_PUBLIC ? (
            <Button href={`${HOSTED_URL}/dashboard`} primary>
              Get a key
            </Button>
          ) : (
            <Button href="/docs#quickstart" primary>
              Quickstart
            </Button>
          )}
          {REPO_PUBLIC && !HOSTED_PUBLIC ? <Button href={REPO}>GitHub</Button> : <Button href="/docs">Docs</Button>}
        </div>

        {/* Three numbers, each from the published results, each linking to where it comes from. */}
        <dl className="mt-14 grid w-full max-w-3xl grid-cols-1 border-y border-line text-left sm:grid-cols-3">
          {[
            scale && {
              value: `${scale.ok.toLocaleString("en-US")}/${scale.n.toLocaleString("en-US")}`,
              label: `sandboxes started at once over ${scale.providers} providers`,
              note: scale.bestSingle ? `Best single provider: ${scale.bestSingle.ok.toLocaleString("en-US")} · ${day(scale.date)}` : day(scale.date),
              href: "#scale",
            },
            { value: String(passed.length), label: "providers pass our real-account check", note: "Ones that fail are tried last", href: "/providers" },
            { value: totalRuns.toLocaleString("en-US"), label: "real sandboxes benchmarked", note: "Started, used and killed", href: "/benchmarks" },
          ]
            .filter((x): x is { value: string; label: string; note: string; href: string } => !!x)
            .map((x, i) => (
              <a key={x.label} href={x.href} className={`group block px-5 py-5 hover:bg-panel ${i ? "border-t border-line sm:border-t-0 sm:border-l" : ""}`}>
                <dt className="sr-only">{x.label}</dt>
                <dd className="font-mono text-[26px] tracking-[-0.02em] text-ink tnum">{x.value}</dd>
                <dd className="mt-1 text-[13px] leading-5 text-ink-2">{x.label}</dd>
                <dd className="mt-1 text-[12px] text-muted group-hover:text-ink-2">{x.note}</dd>
              </a>
            ))}
        </dl>

        <p className="mt-12 max-w-lg text-[15px] leading-7 text-ink-2">
          Each sandbox goes to the cheapest provider that fits. If that one can&apos;t start it, the next one does.{" "}
          {HOSTED_PUBLIC ? "Open source, or one hosted key." : "Open source."}{" "}
          <Link href="/learn" className="text-ink underline underline-offset-4 decoration-line-2 hover:decoration-ink">
            New to sandboxes?
          </Link>
        </p>
        <div className="mt-10 flex w-full max-w-xl flex-col items-center gap-4">
          <InstallChip cmd={`npm i ${NPM}`} />
          <div className="w-full text-left">
            <CodeBlock title="index.ts" code={OWN_KEYS} />
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
          claim="Each sandbox starts on the cheapest provider that fits. If that one can't start it, the next one does."
          actions={
            <>
              <Button href="/docs#routing" primary>
                How routing works
              </Button>
              <Button href="/playground">Try it</Button>
            </>
          }
          points={[
            {
              title: "Fallback when starting",
              body: "Out of credit, rate-limited or down: if a provider can't start your sandbox, the next one does, and every attempt is on sbx.attempts. Once it's running, it stays where it started.",
            },
            { title: "One handle, whatever ran it", body: "Run commands, stream output, move files and pause the same way on every provider." },
            { title: "The provider's own SDK is still there", body: "sbx.native is the provider's own sandbox object, already connected, for ports, snapshots and anything the router doesn't cover." },
            { title: "Nothing left running", body: "If a script crashes, sandboxrouter gc kills the sandboxes it left behind." },
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
                title: "Capacity across providers",
                body: `Every account has a limit on how many sandboxes run at once. Asked for ${scale.n.toLocaleString("en-US")} at once on ${day(scale.date)}, ${
                  scale.bestSingle ? `the best single provider started ${scale.bestSingle.ok.toLocaleString("en-US")}` : "single providers stopped short"
                }; spread over ${scale.providers} providers, ${scale.ok.toLocaleString("en-US")} started, as ${scale.saturated} hit their limit and handed the rest on.`,
              },
              {
                title: "Failover when starting, that remembers",
                body: `A provider that rate-limits you goes to the back of the line for 30 seconds; one that keeps failing to start sandboxes, for a minute. New sandboxes stop waiting on it, and one success brings it back. A sandbox that's already running stays on its provider; if that provider fails mid-run, the work isn't moved.`,
              },
              {
                title: "One key, one bill",
                body: `Every provider behind one sandboxRouter key, billed by the second at list price + ${HOSTED_FEE_PCT}%. Or bring your own provider keys, free.`,
              },
            ]}
            visual={<ScaleChart scale={scale} day={day} />}
          />
        )}

        {short_ && fastest && cheapestTask && (
          <Feature
            label="Benchmarks"
            claim="The same job on every provider, timed and priced the way each one bills."
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
                body: `On the short job, ${cheapestTask.name} cost least: 1,000 runs for $${(cheapestTask.taskUsd * 1000).toFixed(3)}. The fastest, ${fastest.name} (${(fastest.taskMs / 1000).toFixed(1)} s), ranks #${short_.rows.findIndex((r) => r.provider === fastest.provider) + 1} of ${short_.rows.length} on cost.`,
              },
              {
                title: "Real jobs, real accounts",
                body: `${short_.rows.length} providers on real accounts: 100 starts each, 100 sandboxes at once, real jobs from Python to installing a real repo, and a real AI agent doing the same task on each.`,
              },
              {
                title: "Priced by each provider's billing rules",
                body: "Minimum charges and fees count, and active-CPU providers pay for the CPU the job used.",
              },
            ]}
            visual={
              <div className="border border-line p-5 sm:p-8">
                <p className="text-[12px] uppercase tracking-[0.12em] text-muted">Short job · cheapest first</p>
                <ResultTable cols={[{ label: "1,000 runs" }, { label: "Took", className: "hidden sm:table-cell" }]}>
                  {short_.rows.slice(0, 6).map((r, k) => (
                    <ResultRow key={r.provider} rank={k + 1} id={r.provider} name={r.name.replace(/ \(.*\)$/, "")}>
                      <BarNum value={r.taskUsd} max={barMax(short_.rows.slice(0, 6).map((x) => x.taskUsd))}>
                        {money(r.taskUsd * 1000)}
                      </BarNum>
                      <Num className="hidden sm:table-cell">{time(r.taskMs)}</Num>
                    </ResultRow>
                  ))}
                </ResultTable>
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
            <div className="bg-[#0c0f0e] p-6 sm:p-10">
              <PriceIndex dark />
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
              <Button href={REPO_PUBLIC ? REPO : "/docs#quickstart"}>{REPO_PUBLIC ? "GitHub" : "Quickstart"}</Button>
            </>
          }
          points={[
            { title: "Your keys: free", body: "MIT licensed. Sandboxes run on your provider accounts and you pay each provider directly." },
            { title: `One key: list price + ${HOSTED_FEE_PCT}%`, body: "Prepaid credit by card, billed by the second. Sandboxes stop when the credit runs out." },
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
        {scale.n.toLocaleString("en-US")} at once, {day(scale.date)} · where they ran
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
        started over {scale.providers} providers.
        {scale.bestSingle ? (
          <>
            {" "}
            Alone, the best single provider started <span className="font-mono text-ink tnum">{scale.bestSingle.ok.toLocaleString("en-US")}</span>.
          </>
        ) : null}{" "}
        <span className="text-muted">Our accounts, standard limits.</span>
        <span className="mt-2 block text-muted">A sandbox that&apos;s already running stays on its provider; if that provider fails mid-run, the work isn&apos;t moved.</span>
      </figcaption>
    </figure>
  );
}
