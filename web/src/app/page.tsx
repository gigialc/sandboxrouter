import Link from "next/link";
import { Button } from "@/components/chrome";
import { CodeBlock, CodeTabs, InstallChip } from "@/components/code";
import { Feature } from "@/components/Feature";
import { RouteDemo } from "@/components/RouteDemo";
import { DEFAULT_SHAPE, HOSTED_FEE_PCT, HOSTED_PUBLIC, HOSTED_URL, NPM, REPO, REPO_PUBLIC, site } from "@/lib/site";

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
  // Ranked like the router: list price x what the provider really billed, where measured.
  const real = (p: (typeof cloud)[number]) => p.prices[DEFAULT_SHAPE].usd * (p.billedVsList?.ratio ?? 1);
  const cheapest = cloud
    .filter((p) => p.prices[DEFAULT_SHAPE] && !p.prices[DEFAULT_SHAPE].unfit)
    .sort((a, b) => real(a) - real(b))
    .slice(0, 6);
  // Highlight the one the router would pick: the cheapest that anyone can sign up for and that didn't fail its check.
  const pick = cheapest.find((p) => p.live.status !== "failing" && !p.access)?.id;
  const [vcpu, gb] = DEFAULT_SHAPE.split("x");
  // The benchmarks section quotes the short job: who finished first, and who cost least.
  const short_ = site.tasks.kinds.find((k) => k.id === "short");
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
        <p className="mt-10 max-w-lg text-[15px] leading-7 text-ink-2">
          {passed.length} providers tested on real accounts. Each sandbox goes to the cheapest one that fits, and moves on
          when one fails. {HOSTED_PUBLIC ? "Open source, or one hosted key." : "Open source."}
        </p>
        <div className="mt-10 flex w-full max-w-xl flex-col items-center gap-4">
          <InstallChip cmd={`npm i ${NPM}`} />
          <div className="w-full text-left">
            <CodeBlock title="index.ts" code={OWN_KEYS} />
          </div>
        </div>
      </section>

      <div className="overflow-hidden border-y border-line py-6">
        <ul className="flex flex-wrap justify-center gap-x-10 gap-y-3 text-[15px] text-muted">
          {strip.map((p) => (
            <li key={p.id}>
              <Link href={`/providers/${p.id}`} className="hover:text-ink">
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

      <div className="mt-24 space-y-24 sm:mt-28 sm:space-y-32">
        <Feature
          label="Route"
          claim="Each sandbox starts on the cheapest provider that fits, and moves on when one fails."
          actions={
            <>
              <Button href="/docs#routing" primary>
                How routing works
              </Button>
              <Button href="/playground">Try it</Button>
            </>
          }
          points={[
            { title: "Fallback on every failure", body: "Out of credit, rate-limited or down: the next provider takes the sandbox, and every attempt is on sbx.attempts." },
            { title: "One handle, whatever ran it", body: "Run commands, stream output, move files and pause the same way on every provider." },
            { title: "Nothing left running", body: "If a script crashes, sandboxrouter gc kills the sandboxes it left behind." },
          ]}
          visual={<RouteDemo />}
        />

        {short_ && fastest && cheapestTask && (
          <Feature
            flip
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
                body: `On the short job, ${fastest.name} finished first (${(fastest.taskMs / 1000).toFixed(1)} s); ${cheapestTask.name} cost least: 1,000 runs for $${(cheapestTask.taskUsd * 1000).toFixed(3)}.`,
              },
              {
                title: "Real jobs, real accounts",
                body: `${short_.rows.length} providers ran the same work on real accounts: hashing, disk, Python and a download.`,
              },
              {
                title: "Priced by what they really bill",
                body: "Minimum charges and fees count, and active-CPU providers pay for the CPU the job used.",
              },
            ]}
            visual={
              <div className="bg-[#0c0f0e] p-6 sm:p-10">
                <p className="mb-4 font-mono text-[11px] uppercase tracking-[0.14em] text-white/55">Short job, cheapest first</p>
                <table className="w-full text-[14px] text-white">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-[0.12em] text-white/45">
                      <th className="py-2 pr-4 font-normal">Provider</th>
                      <th className="py-2 pr-4 font-normal">Took</th>
                      <th className="py-2 font-normal">1,000 runs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {short_.rows.slice(0, 6).map((r) => (
                      <tr key={r.provider} className="border-t border-white/10">
                        <td className="py-2.5 pr-4">
                          <Link href={`/providers/${r.provider}`} className="hover:underline underline-offset-4">
                            {r.name.replace(/ \(.*\)$/, "")}
                          </Link>
                        </td>
                        <td className="py-2.5 pr-4 font-mono tnum text-white/70">{(r.taskMs / 1000).toFixed(1)} s</td>
                        <td className="py-2.5 font-mono tnum">${(r.taskUsd * 1000).toFixed(3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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
              <p className="mb-4 font-mono text-[11px] uppercase tracking-[0.14em] text-white/55">
                Cheapest at {vcpu} vCPU / {gb} GB
              </p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {cheapest.map((p) => (
                  <Link
                    key={p.id}
                    href={`/providers/${p.id}`}
                    className={`flex aspect-[4/3] flex-col justify-between p-4 ${p.id === pick ? "bg-[#f2f2f2] text-black" : "bg-white/[0.08] text-white hover:bg-white/[0.12]"}`}
                  >
                    <span className="text-[15px]">
                      {short(p.name)}
                      {p.id === pick && <span className="mt-1 block text-[12px] text-black/55">router&apos;s pick</span>}
                    </span>
                    <span className="text-[14px] tnum">
                      {p.billing === "active-cpu" ? "≤ " : ""}${real(p).toFixed(3)}/hr
                      {p.live.status === "passed" && <span className={p.id === pick ? "text-accent" : "text-[#2fbf7f]"}> · tested</span>}
                    </span>
                  </Link>
                ))}
              </div>
              <p className="mt-4 text-[11px] leading-5 text-white/45">
                ≤ bills CPU only while busy.{" "}
                <Link href="/methodology#pricing" className="underline underline-offset-2 hover:text-white/70">
                  How prices work
                </Link>
              </p>
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
