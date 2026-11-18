import type { Metadata } from "next";
import { pageAlternates } from "@/lib/public-pages";
import { PageHeader } from "@/components/chrome";
import Link from "next/link";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  alternates: pageAlternates("/learn"),
  title: "Sandboxes for AI agents, explained",
  description:
    "What a sandbox is, why AI agents need one, how isolation, start times and billing work, and how to compare providers without getting fooled by the price per hour.",
};

const SECTIONS = [
  ["what", "What a sandbox is"],
  ["why", "Why agents need one"],
  ["isolation", "How isolated it is"],
  ["start", "Why some start faster"],
  ["billing", "How you're charged"],
  ["speed", "Speed isn't only start time"],
  ["features", "Features that matter"],
  ["security", "Security checklist"],
  ["market", "Who's who"],
  ["compare", "How to compare providers"],
  ["words", "Words to know"],
] as const;

/** A one-line plain version of the section, set apart from the detail under it. */
function Simply({ children }: { children: React.ReactNode }) {
  return (
    <p className="!my-5 border-l-2 border-accent bg-accent-soft/60 py-3 pl-4 pr-3 !text-ink">
      <span className="mr-2 font-mono text-[11px] uppercase tracking-[0.14em] text-accent-ink">Simply put</span>
      {children}
    </p>
  );
}

/** The guide to sandboxes for AI agents: each idea in one plain line, then what an expert knows about it. */
export default function LearnPage() {
  const cloud = site.providers.filter((p) => !p.local);
  const passed = cloud.filter((p) => p.live.status === "passed").length;
  const short = site.tasks.kinds.find((k) => k.id === "short");
  const long = site.tasks.kinds.find((k) => k.id === "long");
  const byTime = short ? [...short.rows].sort((a, b) => a.taskMs - b.taskMs) : [];
  const fast = byTime[0];
  const slow = byTime.at(-1);
  // The provider whose long job slowed down most against 40 times its short job: steady load versus a burst.
  const slowdown = short && long
    ? long.rows
        .map((l) => {
          const s = short.rows.find((r) => r.provider === l.provider);
          return s ? { name: l.name, ratio: l.taskMs / (s.taskMs * 40) } : null;
        })
        .filter((x): x is { name: string; ratio: number } => x !== null)
        .sort((a, b) => b.ratio - a.ratio)[0]
    : undefined;
  const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  const short_ = (n: string) => n.replace(/ \(.*\)$/, "");

  return (
    <div className="px-5 pt-14 sm:px-10">
      <PageHeader kicker="Learn" title="Sandboxes for AI agents, explained" />
      <p className="mt-5 max-w-2xl text-[15px] leading-7 text-ink-2">
        Everything you need to pick, price and run sandboxes for agents, from the simple idea to the details that decide the
        bill. Each section starts in one plain sentence.
      </p>

      <div className="mt-12 grid gap-12 lg:grid-cols-[200px_1fr]">
        <nav className="hidden lg:block" aria-label="On this page">
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
          <h2 id="what">What a sandbox is</h2>
          <Simply>
            Your agent is a kid who wants to paint. You don&apos;t let it paint in the living room; you give it a playroom with
            plastic on the floor, and if it makes a mess you throw the room away. That room is a sandbox.
          </Simply>
          <p>
            A sandbox is an isolated, disposable computer (CPU, memory, disk and network) that an agent controls through an API.
            You <strong>create</strong> it, <strong>run commands</strong> in it, read and write <strong>files</strong>, stream
            their output, sometimes <strong>pause</strong> it, and <strong>kill</strong> it when you&apos;re done.
          </p>

          <h2 id="why">Why agents need one</h2>
          <Simply>The agent writes code nobody has checked, and it can be tricked by what it reads. That code shouldn&apos;t run on your machine.</Simply>
          <p>
            Agents run untrusted code: code the model wrote, or code smuggled in by <strong>prompt injection</strong> from a web
            page, a file or an email. A sandbox gives the agent a real machine (install packages, run tests, start servers, use a
            browser) without reaching your secrets, your network or other users.
          </p>

          <h2 id="isolation">How isolated it is</h2>
          <Simply>Some playrooms have curtains for walls, some have wooden walls, some are a separate little house. Thicker walls are safer.</Simply>
          <table>
            <thead>
              <tr>
                <th>Wall</th>
                <th>What it is</th>
                <th>Trade-off</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Container</td>
                <td>A separate room that shares the host&apos;s kernel</td>
                <td>Fastest; a kernel bug can let code out</td>
              </tr>
              <tr>
                <td>gVisor</td>
                <td>A stand-in kernel that answers the program&apos;s system calls itself</td>
                <td>Strong, a little slower for some work. Modal and Agent37 use it.</td>
              </tr>
              <tr>
                <td>MicroVM</td>
                <td>A tiny virtual machine with its own kernel (Firecracker)</td>
                <td>Strong, starts in well under a second. E2B, Vercel and Fly use it.</td>
              </tr>
              <tr>
                <td>Full VM</td>
                <td>A whole virtual machine</td>
                <td>Strong and slow to start</td>
              </tr>
            </tbody>
          </table>
          <p>
            For code you didn&apos;t write, pick a microVM or gVisor. A tell for shared-kernel isolation: in our benchmarks one
            provider&apos;s sandbox reported the whole host machine&apos;s CPU counters instead of its own.
          </p>

          <h2 id="start">Why some start faster</h2>
          <Simply>Some shops keep playrooms built in the back; some rebuild one from a photo; some build from scratch.</Simply>
          <p>
            <strong>Cold start</strong> is the time from asking for a sandbox to running its first command. Providers hide boot
            time with <strong>warm pools</strong> (machines already running) and <strong>memory snapshots</strong> (a running
            machine saved and restored, processes included), which also lets you <strong>fork</strong> a sandbox mid-task.
            Start times include the network, so they depend on where you are. See the{" "}
            <Link href="/benchmarks#speed">measured start times</Link>.
          </p>

          <h2 id="billing">How you&apos;re charged</h2>
          <Simply>
            Some shops charge for every hour the playroom exists. Others charge only while the kid is painting, plus rent for
            the room.
          </Simply>
          <ul>
            <li>
              <strong>Allocated</strong>: you pay for the CPU and memory you reserved, busy or not (E2B, Daytona, Boat, Maritime,
              Agent37, and Modal for the size you reserve).
            </li>
            <li>
              <strong>Active CPU</strong>: CPU only while it&apos;s busy, memory all the time (Vercel, Cloudflare, Tensorlake,
              AgentCore, Sail, Sprites). Agents spend much of their time waiting on the model, so this can cost a fraction of the
              listed price. Modal says a typical sandbox spends more than half its life under 6% of its peak CPU.
            </li>
            <li>
              <strong>The fine print decides short jobs</strong>: minimum charges (Agent37 and CodeSandbox bill at least a minute;
              Vercel&apos;s minute covers memory only), billing steps (per second or per minute), per-sandbox fees (Sail adds $0.01
              each), floors (Tensorlake bills at least 20% CPU), plus disk, data out and monthly plans.
            </li>
          </ul>
          <p>
            So the question is never the price per hour; it&apos;s what your job costs. The same provider can be first for a
            30-minute session and seventh for a 10-second tool call. That&apos;s what the{" "}
            <Link href="/benchmarks#cost">cost tables</Link> rank by, and <Link href="/methodology#pricing">how prices work</Link>{" "}
            has the details.
          </p>

          <h2 id="speed">Speed isn&apos;t only start time</h2>
          <Simply>Two playrooms both come with &ldquo;2 crayons&rdquo;, but one set draws twice as fast.</Simply>
          <p>
            A vCPU isn&apos;t a fixed unit: chips and sharing differ.
            {fast && slow ? (
              <>
                {" "}
                On the same short job, {short_(fast.name)} took {secs(fast.taskMs)} and {short_(slow.name)} took {secs(slow.taskMs)}.
              </>
            ) : null}{" "}
            Some machines are fast for a moment and then slow down under steady load
            {slowdown && slowdown.ratio > 1.5 ? (
              <>
                : {short_(slowdown.name)}&apos;s long job took {slowdown.ratio.toFixed(1)}× what its short job predicted
              </>
            ) : null}
            . Disk and network speed matter too, for cloning repos and installing packages. Price per job is speed times the
            billing rules: see the <Link href="/benchmarks#task">cost of a real task</Link>.
          </p>

          <h2 id="features">Features that matter</h2>
          <Simply>Some playrooms have a shelf to keep toys overnight, a window to the internet, or a TV.</Simply>
          <ul>
            <li>
              <strong>Custom images</strong>: start from your own container with your tools already installed.
            </li>
            <li>
              <strong>Persistence</strong>: pause and resume, volumes, sleeping between agent turns, and snapshots that really
              bring back your files and processes.
            </li>
            <li>
              <strong>Networking</strong>: internet on or off (one code interpreter we tested had none by default), limits on what
              it can reach, and open ports or preview URLs so an agent can show you what it built.
            </li>
            <li>
              <strong>Limits</strong>: how long a session can run, how many sandboxes at once, the largest size, and regions.
            </li>
            <li>
              <strong>Extras</strong>: GPUs, full desktops and phones for agents that use a screen, and SDKs in your language.
            </li>
          </ul>
          <p>
            Each <Link href="/providers">provider page</Link> lists what it supports and passed in our check.
          </p>

          <h2 id="security">Security checklist</h2>
          <Simply>Give the kid the playroom, not the keys to the house.</Simply>
          <ul>
            <li>Match the walls to the code: microVM or gVisor for anything untrusted.</li>
            <li>
              Never put your real API keys inside the sandbox. Keep them outside, in a proxy that adds them, or use short-lived
              keys that can do one thing.
            </li>
            <li>Limit where the sandbox can send data, so injected code can&apos;t ship your data out.</li>
            <li>
              Set timeouts and always kill sandboxes; clean up the ones a crash left behind. A forgotten sandbox is money running
              out.
            </li>
            <li>Treat everything the agent reads as possibly written by an attacker.</li>
          </ul>

          <h2 id="market">Who&apos;s who</h2>
          <Simply>There are dozens of playroom shops now, and they don&apos;t all sell the same thing.</Simply>
          <ul>
            <li>
              <strong>Code interpreters</strong>, for quick runs: E2B, AgentCore, Novita.
            </li>
            <li>
              <strong>Dev environments</strong>, for long, stateful work: Daytona, CodeSandbox, Runloop.
            </li>
            <li>
              <strong>Cloud platforms</strong> that added sandboxes: Vercel, Cloudflare, Modal, Fly (Sprites), AWS Lambda MicroVMs.
            </li>
            <li>
              <strong>Low-price newcomers</strong> competing on cost: Agent37, Boat, Maritime, OpenScale, Sail.
            </li>
          </ul>
          <p>
            Where it&apos;s going: lower prices, paying for what you use, sandboxes that sleep between an agent&apos;s turns,
            snapshots and forks for running many agents in parallel, and agent platforms letting you bring your own sandbox.
            sandboxRouter tracks {cloud.length} providers, {passed} of them tested on real accounts; see{" "}
            <Link href="/providers">all of them side by side</Link>.
          </p>

          <h2 id="compare">How to compare providers</h2>
          <Simply>Before you believe a &ldquo;50× cheaper&rdquo; chart, ask three questions.</Simply>
          <ol>
            <li>
              <strong>At what CPU use?</strong> An active-CPU provider looks expensive at 100% and cheap at 10%. Agents are usually
              closer to 10%.
            </li>
            <li>
              <strong>For how long a job?</strong> Minimum charges and per-sandbox fees flip the ranking between a 10-second and a
              30-minute run.
            </li>
            <li>
              <strong>Same size, same speed?</strong> Fixed default sizes and slower CPUs make two &ldquo;2 vCPU&rdquo; prices
              different things.
            </li>
          </ol>
          <p>
            Then measure your own job: <code>npx @sandboxrouter/sdk bench --task --job python</code> runs one on every provider
            you have keys for.
          </p>

          <h2 id="words">Words to know</h2>
          <dl className="grid gap-x-6 gap-y-3 text-[0.95rem] sm:grid-cols-[180px_1fr]">
            {[
              ["Cold start", "Time from asking for a sandbox to running its first command."],
              ["Warm pool", "Machines kept running so a new sandbox doesn't wait for a boot."],
              ["Snapshot, fork, restore", "Save a running machine, copy it, or bring it back later."],
              ["MicroVM, Firecracker", "A tiny virtual machine with its own kernel; Firecracker is the common one."],
              ["gVisor", "A stand-in kernel between the program and the host."],
              ["Active CPU vs allocated", "Paying for CPU while it's busy, or for what you reserved."],
              ["Minimum charge, billing step", "The least you're billed, and the unit time is rounded up to."],
              ["Egress", "Data the sandbox sends out; often billed, and worth limiting."],
              ["Preview URL", "A link to a port in the sandbox, to see what an agent built."],
              ["Concurrency limit", "How many sandboxes you can run at once."],
              ["Burst vs throttle", "Fast for a moment, then slowed under steady load."],
              ["Cost per task", "What a real job costs: speed times billing rules."],
              ["Prompt injection", "Instructions hidden in what the agent reads, meant to take it over."],
            ].map(([term, def]) => (
              <div key={term} className="contents">
                <dt className="font-medium text-ink">{term}</dt>
                <dd className="m-0 text-ink-2">{def}</dd>
              </div>
            ))}
          </dl>
        </article>
      </div>
    </div>
  );
}
