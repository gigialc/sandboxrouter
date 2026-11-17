import type { Metadata } from "next";
import { PageHeader } from "@/components/chrome";
import Link from "next/link";
import { CodeBlock } from "@/components/code";
import { HOSTED_FEE_PCT, NPM, REPO, REPO_PUBLIC, site } from "@/lib/site";

export const metadata: Metadata = {
  title: "Methodology",
  description: "How sandboxRouter prices providers, tests them on real accounts and runs its benchmarks.",
};

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

const SECTIONS = [
  ["pricing", "Prices"],
  ["index", "The price index"],
  ["active-cpu", "Providers that bill active CPU"],
  ["check", "The real-account check"],
  ["speed", "Start time"],
  ["jobs", "Real work"],
  ["agent", "A real agent"],
  ["load", "Under load"],
  ["bills", "Measured bills"],
  ["limits", "What this doesn't cover"],
  ["runs", "Where it ran, and adding a run"],
] as const;

/** Everything the tables leave out: how each number is made. One section per table, linked from the table. */
export default function MethodologyPage() {
  const cloud = site.providers.filter((p) => !p.local);
  const passed = cloud.filter((p) => p.live.status === "passed").length;
  const active = cloud.filter((p) => p.billing === "active-cpu").map((p) => p.name.replace(/ \(.*\)$/, ""));
  const billed = cloud.filter((p) => p.billedVsList);
  const noBench = cloud.filter((p) => p.noBenchmarks).map((p) => p.name);
  const subs = [...site.submissions].sort((a, b) => b.date.localeCompare(a.date));

  return (
    <div className="px-5 pt-14 sm:px-10">
      <PageHeader kicker="Methodology" title="How the numbers are made" />

      <div className="mt-12 grid gap-12 lg:grid-cols-[200px_1fr]">
        <nav className="hidden lg:block">
          <ul className="sticky top-24 space-y-2 text-[13px] text-muted">
            {SECTIONS.map(([id, title]) => (
              <li key={id}>
                <a href={`#${id}`} className="hover:text-ink">
                  {title}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <article className="prose-sr max-w-2xl">
          <h2 id="pricing">Prices</h2>
          <p>
            Every price starts from the provider&apos;s public pricing page; each <Link href="/providers">provider page</Link> links the source
            and the date it was checked, and a watcher flags pricing pages that change. A price is for the size you ask for, or the
            size the provider really gives: some round up to their next size, and a few fix the size of their default image (E2B,
            OpenScale, Daytona).
          </p>
          <p>
            Ranking prices a whole run, not an hour: running time is rounded up to the provider&apos;s billing step and minimum charge,
            and any per-sandbox fee is added. So a 10-second job can go to a provider that bills by the second over one that is
            cheaper per hour but charges a full minute. The run is <code>expectedSeconds</code> if you give it, else the whole{" "}
            <code>timeoutMinutes</code>.
          </p>
          <p>
            Where we measured what a provider really bills ({billed.map((p) => p.name).join(", ") || "none yet"}), its price is
            corrected by that ratio. Everywhere else it&apos;s the list price. Disk, network and monthly plans aren&apos;t included. The
            hosted key adds {HOSTED_FEE_PCT}% on sandboxes that run on our accounts; with your own keys there&apos;s no fee.
          </p>

          <h2 id="index">The price index</h2>
          <p>
            The index puts a number on a few standard pieces of work: a 2 vCPU / 4 GB sandbox for an hour, an agent session for an
            hour at 10% CPU, and 1,000 tool calls of 10 seconds each in fresh sandboxes. Each line is the median of what the
            router would charge across the providers that passed the real-account check, priced as above (minimum charges,
            billing steps, per-sandbox fees and measured bills included), with the cheapest provider beside it. It&apos;s recorded
            daily when it changes, which happens when a provider changes its price, so the change shown is since the last
            recorded value.
          </p>

          <h2 id="active-cpu">Providers that bill active CPU</h2>
          <p>
            {active.join(", ")} bill CPU only while it&apos;s busy, and memory all the time. Their listed price assumes every core is
            busy, which is the most an hour can cost; the tables mark it with ≤. An agent that mostly waits on model calls uses about
            10% CPU, so it pays far less there. Set <code>cpuUtilization</code> (0 to 1) and the router prices them at that share of
            their CPU plus their full memory. The Agent sessions job on the benchmarks page assumes 10%.
          </p>
          <p>
            Details follow each provider&apos;s rules: Vercel&apos;s one-minute minimum covers memory only, and Tensorlake bills at
            least 20% CPU even when idle. Modal bills the larger of what you reserve and what you use: with{" "}
            <code>cpuUtilization</code> below 1 the router reserves only that share of the CPU (at least 1/8 core) and lets the
            sandbox burst to the full size, so it&apos;s priced like active CPU; without it, Modal reserves the full size and is priced
            as allocated capacity. Memory is reserved in full either way.
          </p>
          <p>
            <strong>Vercel&apos;s meter, checked.</strong> Vercel reports the active CPU it metered for each sandbox. We compared it
            with what the sandbox itself counted: waiting was nearly free (3.3 s metered over three idle minutes), and two busy
            cores matched (24.1 s metered, 23.1 s counted inside). But one busy core on a 2 vCPU sandbox was metered at about
            twice its time (22.7 s for 11.2 s of work): while any core works, every vCPU counts. Single-threaded work, which most
            tool calls are, costs about double what a per-core reading suggests, so Vercel&apos;s jobs are priced as its vCPUs times
            the busiest core&apos;s time.
          </p>

          <h2 id="check">The real-account check</h2>
          <p>
            A provider counts as tested once it passes {site.checkSteps.length} steps on a real account: {site.checkSteps.join("; ")}.
            {" "}{passed} of {cloud.length} pass today. Providers whose last check failed are still used, but tried last. Nobody pays
            for a position: the order comes from price and these results only.
          </p>

          <h2 id="speed">Start time</h2>
          <p>
            Each run asks one provider for a 2 vCPU / 4 GB sandbox (or its fixed default size), with fallback off. The{" "}
            <strong>cold start</strong> is the time until the sandbox can run a command. The <strong>command round trip</strong> is how
            long <code>echo ok</code> takes to answer. Then the sandbox is killed. Any error counts the run as failed.
          </p>
          <p>
            Times include the network between the test machine and the provider, so where a run happens matters. Each table row
            uses each location&apos;s best-sampled run from its last 30 days (the one with the most runs, newest on a tie), and
            the median across locations when there are several, so one heavy submitter can&apos;t move it. A run is a snapshot from one machine, not an average over days.
          </p>

          <h2 id="jobs">Cost of a real task</h2>
          <p>The same job runs in a sandbox on every provider, using only tools every Linux image has:</p>
          <ul>
            <li>
              <strong>Short job</strong>: hash 512 MB on one core, then 256 MB on each of two cores at once, then write and flush
              256 MB to disk.
            </li>
            <li>
              <strong>Long job</strong>: the short job 40 times in a row. It shows whether a provider keeps its speed under steady
              load, and how prices compare once minimum charges stop mattering.
            </li>
            <li>
              <strong>Python</strong>: 200,000 records through JSON, a regex and a sort, like a code-interpreter call.
            </li>
            <li>
              <strong>Download</strong>: the 53 MB Node.js release from nodejs.org, like installing a toolchain.
            </li>
            <li>
              <strong>Agent loop</strong>: 10 turns of waiting 6 s (the model thinking, a simulated model call; the sandbox sits
              idle) and then a short Python tool call. About a minute, mostly idle. Its sandboxes start with a 10% CPU hint, as an
              agent&apos;s would.
            </li>
            <li>
              <strong>Real repo</strong>: what a coding agent does first. Download Node 22 and a pinned commit of a real TypeScript
              project (sandboxRouter itself), install its 364 packages with <code>npm ci</code>, and typecheck it. Needs only tar and
              a way to download, so a bare image can run it.
            </li>
          </ul>
          <p>
            Each job runs at least 3 times per provider (the real repo 10), and start times 100 times; the tables show medians.
            &ldquo;Best value&rdquo; ranks by cost and time together: each divided by the median across providers, multiplied, so
            1.0 is the median on both and lower is better. Every ranking is <strong>per successful run</strong>: a provider whose
            runs sometimes failed has its cost and time divided by its success rate, so failing often costs it places. Refusals
            for our account&apos;s own limits aren&apos;t failures and are left out. The raw results behind every number are in the
            public results folder, failed runs included.
          </p>
          <p>
            Each job is priced two ways: in a <strong>new sandbox</strong> (its start, minimum charge and per-sandbox fee count
            every time) and in <strong>one sandbox for all jobs</strong> (only the job&apos;s own time counts), since agents often
            reuse a sandbox for many calls. Each step is timed from the test machine, minus the sandbox&apos;s own round trip for an empty command, so network
            distance mostly drops out. The cost is what the provider would bill for the start plus the job, with its minimum
            charge, billing step and per-sandbox fee. These are published prices applied to measured times, not invoices.
          </p>
          <p>
            Providers that bill active CPU are charged for the CPU time the job really used, plus memory for the whole run. It is
            read from the sandbox&apos;s own counters (<code>/proc/stat</code>) before and after each step. A container can show the
            whole host&apos;s counters instead of its own; a reading higher than the sandbox&apos;s vCPUs could produce in that time is
            thrown out, and that provider is priced with every core busy.
          </p>

          <h2 id="agent">A real agent</h2>
          <p>
            A real model (Gemini) gets the same task in a sandbox on every provider: write a Python script that computes the first
            5,000 primes, saves them and prints their sum, and fix it until it works. It has one tool, which runs a shell command in
            the sandbox. The model runs on the test machine and its key never enters the sandbox, so the sandbox waits while the
            model thinks, as it would for any agent. Afterwards the result is checked independently inside the sandbox. Each
            provider runs it five times; the table shows how many were done right, the median session, the share of it the
            sandbox sat waiting, and what the sandbox was billed (the model&apos;s own cost isn&apos;t included). Its sandboxes start
            with a 10% CPU hint, so providers that bill active CPU or reserve CPU are priced as an agent would use them.
          </p>

          <h2 id="load">Under load</h2>
          <p>
            100 sandboxes are asked for on one provider at the same moment, as parallel agents or an RL run start them. Each must
            answer a command; the time it takes counts from the moment all of them were asked for, so waiting in the
            provider&apos;s queue counts. The table shows how many started, the time at the median (p50) and for the slowest 1%
            (p99), how long until the last one finished, and what all of them cost. Two variants run a job in each sandbox: a
            short Python step (RL rollouts and evals) and the minute-long agent loop (parallel agents). Sandboxes the provider
            refused for a limit on our test account are counted apart: that limit is ours, not the provider&apos;s, and
            larger accounts get higher ones.
          </p>
          <p>
            To compare everyone fairly, the same tests also run at <strong>10 at once</strong>, a size every account allows, so
            every provider faces the same load; 100 at once then shows how fast and steady each one is <strong>at scale</strong>.
            Providers are ranked only against others that started all of them, since a smaller load isn&apos;t comparable;
            ones our test account&apos;s limit held back are named as not measured at that size yet. Cost is scaled to 100 sandboxes from the ones that ran. Rows
            built on far fewer runs than the rest say how many.
          </p>

          <h2 id="bills">Measured bills</h2>
          <p>
            To check list prices against reality, a sandbox runs for a fixed time with every core busy, and the bill is read back
            from the provider&apos;s own billing API. Only providers whose bill we could read are listed. The ratio of billed to
            list price corrects that provider&apos;s price everywhere.
          </p>

          <h2 id="limits">What this doesn&apos;t cover</h2>
          <ul>
            <li>Results so far come from one location. Start times and download speed depend on where you are.</li>
            <li>Compute speed isn&apos;t normalized across providers: the jobs measure it, but the router doesn&apos;t route on it yet.</li>
            <li>Networking beyond one download, package installs, GPUs, and snapshot and restore aren&apos;t measured.</li>
            <li>Most prices come from pricing pages, not invoices.</li>
            {noBench.length > 0 && (
              <li>
                {noBench.join(", ")}&apos;s terms don&apos;t allow publishing benchmarks, so they&apos;re left out of every benchmark.
              </li>
            )}
          </ul>

          <h2 id="runs">Where it ran, and adding a run</h2>
          <ul>
            {subs.map((s) => (
              <li key={s.date}>
                {day(s.date)}: {s.label ?? "unlabelled"} ({s.platform}), {s.runs} runs on each of {s.providers} providers
                {s.by ? `, by @${s.by}` : ""}
              </li>
            ))}
          </ul>
          <p>
            Run it with your own keys{REPO_PUBLIC ? <> and send the report as a pull request to <a href={`${REPO}/tree/main/results`}>results/</a></> : null}.
            Label it with a city or cloud region, never an address.
          </p>
          <CodeBlock title="terminal" code={`npx ${NPM} bench --task --runs 3 --label "Tokyo" --submit`} />
          <p>
            With the <a href="https://cli.github.com">GitHub CLI</a> signed in, <code>--submit</code> opens the pull request for you.
            Only the report is sent, never keys; providers whose every run failed on your own account are left out, and nothing is
            written if your connection drops. A weekly run from GitHub&apos;s own servers in the US adds a second location.
          </p>
        </article>
      </div>
    </div>
  );
}
