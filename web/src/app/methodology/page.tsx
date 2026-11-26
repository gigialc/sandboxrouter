import type { Metadata } from "next";
import { pageAlternates } from "@/lib/public-pages";
import { PageHeader } from "@/components/chrome";
import Link from "next/link";
import { ConditionalStartFeeNote } from "@/components/ConditionalStartFeeNote";
import { CodeBlock } from "@/components/code";
import { HOSTED_FEE_PCT, NPM, REPO, REPO_PUBLIC, site } from "@/lib/site";

export const metadata: Metadata = {
  alternates: pageAlternates("/methodology"),
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
            and any modelled per-sandbox fee is added. So a 10-second job can go to a provider that bills by the second over one that is
            cheaper per hour but charges a full minute. The run is <code>expectedSeconds</code> if you give it, else the whole{" "}
            <code>timeoutMinutes</code>.
          </p>
          <p>
            Where we measured what a provider really bills ({billed.map((p) => p.name).join(", ") || "none yet"}), its price is
            corrected by that ratio. Everywhere else it uses the list price. Estimates exclude disk, network and monthly plans.
            {" "}<ConditionalStartFeeNote ids={["boat", "sail"]} />
          </p>
          <p>
            Hosted charges on our provider accounts use estimated provider compute rates plus {HOSTED_FEE_PCT}% and assume full CPU.
            The hosted API rejects <code>cpuUtilization</code>. With your own provider keys, you pay the provider directly.
          </p>

          <h2 id="index">The price index</h2>
          <p>
            The index puts a number on a few standard pieces of work: a 2 vCPU / 4 GB sandbox for an hour, an agent session for an
            hour at an assumed 10% CPU, and 1,000 tool calls of 10 seconds each in fresh sandboxes. Each line shows the median
            and lowest estimated direct-provider cost among tested providers that fit the job. It uses the pricing rules above and
            scales the single-run estimate for 1,000 calls, assuming starts remain within plan allowances. These scenarios use
            direct provider rates. The change shown is since the last recorded value.
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
            Each run targets one provider. The standard request is 2 vCPU / 4 GB, or the provider&apos;s fixed default size. If a provider only
            has results at a smaller requested size, the site shows that measurement and labels its size.{" "}
            <strong>Create</strong> measures the API response. <strong>Command</strong> measures the subsequent{" "}
            <code>echo ok</code> round trip. New reports also measure <strong>readiness</strong> from the create request to that command&apos;s
            successful output. The dashboard lists create and command medians separately to keep older reports comparable.
          </p>
          <p>
            Times include the network between the test machine and the provider, so where a run happens matters. Each table row
            uses each location&apos;s best-sampled run from its last 30 days (the one with the most runs, newest on a tie), and
            the median across locations when there are several. A run is a snapshot from one machine. New reports separate create,
            first-command and cleanup failures.
          </p>

          <h2 id="jobs">Cost of a real task</h2>
          <p>The same job runs in a sandbox on every provider, using only tools every Linux image has:</p>
          <ul>
            <li>
              <strong>Short job</strong>: hash 512 MB, then run two 256 MB hashes concurrently, then write and flush
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
            Workload reports use a versioned script, check the output and count all requests. A sandbox can start successfully
            while its job fails. Rankings prefer the requested 2 vCPU / 4 GB cohort and can show a smaller measured cohort when a provider
            has no verified runs for the standard request. The table labels each non-standard configured size. Each provider&apos;s timings come
            from one size for that task.
          </p>
          <p>
            Older workload reports remain in the results archive. Current rankings require a rerun with the new workload
            checks. For those runs, time and cost are divided by the observed completion rate as a retry estimate.
            &ldquo;Best value&rdquo; multiplies those two estimates after each is divided by the corresponding median across providers.
            The comparison records limit refusals, start failures and workload failures separately.
          </p>
          <p>
            Each job is priced two ways: in a <strong>new sandbox</strong> (its start and minimum charge count
            every time) and in <strong>one sandbox for all jobs</strong> (only the job&apos;s own time counts), since agents often
            reuse a sandbox for many calls. Each step is timed from the test machine, minus the sandbox&apos;s own round trip for an empty command, so network
            distance mostly drops out. We apply published rates and modelled minimums, billing steps and per-sandbox fees
            to those times. Start fees that depend on your plan (Sail&apos;s $0.01 on its free plan, Boat&apos;s above its allowance) are left out and noted.
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
            model thinks, as it would for any agent. The verifier compares the full 5,000-number sequence to an independently
            computed list, then reruns the script and checks that it regenerates the file and prints the correct sum.
            The table compares one model and task version at a time. It shows verified outputs, median session time, time spent
            waiting on the model, and estimated sandbox compute cost. Its sandboxes start
            with a 10% CPU hint, so providers that bill active CPU or reserve CPU are priced as an agent would use them.
          </p>

          <h2 id="load">Under load</h2>
          <p>
            The harness issues batches of 10 or 100 requests to one provider. Ready means the first command returned successfully,
            timed from the start of the batch. The median and p99 are based on successful observations, and the last outcome
            includes failures. Python and simulated-agent workloads require the newer task versions before they get a rank.
          </p>
          <p>
            A latency rank requires every request in the batch to complete. The table also shows partial and zero-completion
            results. Reported limit refusals describe those attempts and can depend on the plan, account or provider.
            Older reports cannot tell us which stage caused other failures. Complete-batch costs are estimates scaled to 100
            requests.
          </p>

          <h2 id="image">Your own image</h2>
          <p>
            The harness gives each provider the registry address of a public image and asks for a sandbox, through the
            router, with no template, snapshot or blueprint built beforehand. Only providers that accept an image
            address directly can be in this table. Every run uses 4 vCPU and 8 GB.
          </p>
          <p>
            The first start includes the provider pulling and preparing the image. It can be measured once per image
            and account, so it is a single observation, and it grows with the size of the image. The later starts are
            the median of three, made right after it.
          </p>
          <p>
            Each sandbox runs a command whose output identifies the image, such as the language version. A provider
            is listed only when every one of its sandboxes was the image asked for. Times are from one location; the
            hourly price is the list price at that size.
          </p>

          <h2 id="bills">Measured bills</h2>
          <p>
            Each direct check starts one sandbox, checks the size, applies CPU load unless marked idle, and deletes it.
            The list estimate uses wall time at the requested size. The table reports provider usage at the precision the
            billing endpoint supplies. Credits, reporting delay, billing increments and when the provider starts its clock can
            affect the amount. A loaded run of at least ten minutes with a sufficiently precise usage record can inform estimated
            routing prices.
          </p>
          <p>
            A hosted check compares the quote with the final credit debit after a verified command and deletion.
            The original quote uses the requested duration. A separately recorded quote can adjust for the actual runtime.
            These debits include the SandboxRouter service fee.
          </p>

          <h2 id="limits">What this doesn&apos;t cover</h2>
          <ul>
            <li>Archived results come from one location in Europe. Start times and download speed depend on where you are.</li>
            <li>Burst tests clean up each sandbox as it finishes. Establishing peak live concurrency requires holding sandboxes open at a common barrier.</li>
            <li>Compute speed isn&apos;t normalized across providers: the jobs measure it, but the router doesn&apos;t route on it yet.</li>
            <li>Networking beyond one download, package installs, GPUs, and snapshot and restore aren&apos;t measured.</li>
            <li>Most prices come from pricing pages, not invoices.</li>
            {noBench.length > 0 && (
              <li>
                No measured results are published for {noBench.join(", ")}: {noBench.length > 1 ? "their" : "its"} terms don&apos;t allow
                it. {noBench.length > 1 ? "They appear" : "It appears"} only in list-price estimates.
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
