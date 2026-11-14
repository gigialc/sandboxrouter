import type { Metadata } from "next";
import { TableScroll } from "@/components/chrome";
import { CodeBlock } from "@/components/code";
import { HOSTED_FEE_PCT, HOSTED_PUBLIC, HOSTED_URL, REPO, REPO_PUBLIC, site } from "@/lib/site";

export const metadata: Metadata = { title: "Docs" };

const SECTIONS = [
  ["quickstart", "Quickstart"],
  ["keys", "Provider keys"],
  ["routing", "Routing"],
  ["price-table", "Reading the price table"],
  ["fallback", "Fallback"],
  ["streaming", "Streaming output"],
  ["files", "Files"],
  ["pause", "Pause and resume"],
  ["computers", "Desktops and phones"],
  ["server", "HTTP server"],
  ...(HOSTED_PUBLIC ? ([["hosted", "Hosted key"]] as const) : []),
  ["python", "Python"],
  ["bench", "Bench and leaderboard"],
  ["providers", "Adding a provider"],
] as const;

export default function DocsPage() {
  const fixedSizes = site.providers
    .filter((p) => p.defaultSize)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => `${p.name} ${p.defaultSize!.vcpu} vCPU / ${p.defaultSize!.memoryGb} GB`)
    .join(", ");
  return (
    <div className="grid gap-10 px-5 sm:px-10 pt-14 lg:grid-cols-[13rem_1fr] xl:gap-16">
      <aside className="hidden lg:block">
        <nav className="sticky top-24 space-y-1 text-sm">
          <p className="mb-3 font-mono text-xs uppercase tracking-widest text-muted">Docs</p>
          {SECTIONS.map(([id, label]) => (
            <a key={id} href={`#${id}`} className="block px-2 py-1 text-ink-2 hover:bg-panel-2 hover:text-ink">
              {label}
            </a>
          ))}
        </nav>
      </aside>

      <article className="prose-sr min-w-0 max-w-3xl">
        <h1 className="text-4xl font-semibold tracking-tight">Docs</h1>
        <p>
          sandboxrouter gives your agent one API for {site.providers.length} sandbox providers. It picks a provider for each
          sandbox, falls back when one fails, and hands you back the same handle whatever ran it.
        </p>

        <h2 id="quickstart">Quickstart</h2>
        <CodeBlock title="terminal" code={`npm i @sandboxrouter/sdk\nexport E2B_API_KEY=...   # any one provider's key is enough to start`} />
        <div className="h-3" />
        <CodeBlock
          title="agent.ts"
          code={`import { Router } from "@sandboxrouter/sdk";

const router = new Router();
const sbx = await router.create({ timeoutMinutes: 10 });
try {
  await sbx.writeFile("/tmp/hello.py", "print('hello from a sandbox')");
  const r = await sbx.exec("python3 /tmp/hello.py");
  console.log(r.exitCode, r.stdout, "on", sbx.provider);
} finally {
  await sbx.kill();
}`}
        />
        <p>
          Always kill the sandbox when you&apos;re done; each provider also ends it on its own at <code>timeoutMinutes</code>.
          In TypeScript 5.2+ (or Node 24+) you can write <code>await using sbx = ...</code> instead, which kills it when the block ends.
        </p>
        <p>
          Ask for a size with <code>{`{ vcpu: 2, memoryGb: 4 }`}</code>. With no size you get 2 vCPU / 4 GB, except on providers whose
          default image has a fixed size ({fixedSizes}), where you get that. Ask for more and those providers are skipped unless you
          pass a custom <code>image</code> built at the size you need.
        </p>
        <p>
          No account yet? Use Docker on your own machine: start Docker, then pass <code>{`{ provider: "docker" }`}</code>. It&apos;s
          free, and fine for trying things out, but a container shares your kernel, so use a cloud provider for untrusted code.
        </p>
        <p>Try it without writing code:</p>
        <CodeBlock title="terminal" code={`npx @sandboxrouter/sdk providers                 # prices + which keys are set\nnpx @sandboxrouter/sdk run "uname -a && nproc"   # start, run, print, kill`} />

        <h2 id="keys">Provider keys</h2>
        <p>
          Set keys for the providers you use. Providers without keys are skipped. Some adapters call the provider&apos;s HTTP API
          directly; the rest need the provider&apos;s own package installed next to sandboxrouter (each provider&apos;s page says
          which).
        </p>
        <TableScroll>
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Env</th>
              </tr>
            </thead>
            <tbody>
              {site.providers.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td className="font-mono text-xs">{p.credentials.length ? p.credentials.map((g) => g.join(" + ")).join("  or  ") : "Docker running locally"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>

        <h2 id="routing">Routing</h2>
        <p>The second argument to <code>create</code> decides where a sandbox goes.</p>
        <CodeBlock
          code={`router.create(spec)                                // cheapest real cost; speed breaks near-ties
router.create(spec, { strategy: "cheapest" })      // lowest list price alone
router.create(spec, { strategy: "fastest" })       // lowest start time, measured where you run it
router.create(spec, { strategy: "verified" })      // providers that passed the check first
router.create(spec, { provider: ["e2b", "modal"] }) // try these, in this order
router.create({ gpu: "A10G" })                      // only GPU-capable providers are tried
router.create(spec, { require: ["pause"] })         // only providers that can pause`}
        />
        <p>
          With no strategy, the router goes cheapest first among providers you have keys for, by list price for the size you asked
          for. Where we measured what a provider really bills (a sandbox run for a fixed time, then the provider&apos;s own bill),
          its price is corrected by that ratio (<code>BILLED_VS_LIST</code>). Providers within 10% of each other on price go fastest first,
          by start times this router measured itself, or from your <code>sandboxrouter bench</code> run until it has some. Speed depends on
          where you run it, so the published benchmarks are never used for routing. Providers whose last 14-step real-account check
          failed go last. Ties break alphabetically, so no provider gets a better slot by who it is. Prices come from each
          provider&apos;s public pricing page and live in <code>src/catalog.ts</code>. A service that runs sandboxes on its own accounts can
          create its router with <code>{`new Router({ requireVerified: true })`}</code> to use only providers that passed the check. Docker is never picked automatically; name it
          with <code>{`{ provider: "docker" }`}</code>. To see what would happen without starting anything, call{" "}
          <code>router.plan(spec, route)</code> or run <code>npx @sandboxrouter/sdk route</code>. Every skipped provider comes with
          a reason, like <code>not configured</code> or <code>max 16 vCPU</code>.
        </p>

        <h2 id="price-table">Reading the price table</h2>
        <ul>
          <li>
            <strong>Order:</strong> providers anyone can sign up for come first, cheapest first, ties alphabetical; waitlisted or
            closed sign-ups follow, then providers that can&apos;t take the size. The router goes cheapest first among providers you
            have keys for, with speed breaking near-ties (see Routing).
          </li>
          <li>
            <strong>List price / hr:</strong> each provider&apos;s public list price while running, read off its pricing page. An
            estimate, not a bill: the benchmarks page compares it with real bills where a provider has a billing API.
          </li>
          <li>
            <strong>≤:</strong> CPU is billed only while busy, so the price shown is with every core busy and idle work costs less.
          </li>
          <li>
            <strong>&ldquo;at 2 vCPU · 0.5 GB only&rdquo;:</strong> the provider&apos;s default image runs at that size whatever you
            ask for; a bigger size needs your own image.
          </li>
          <li>
            <strong>Plan needed:</strong> the monthly plan required before the API creates sandboxes (&ldquo;credited&rdquo; = paid
            back as usage). For a small project it can cost more than the usage.
          </li>
          <li>
            <strong>Cold start:</strong> medians from the benchmark reports submitted so far; with few reports, a rough guide.
          </li>
          <li>
            <strong>Real account:</strong> whether the 14-step check has passed on a real account. &ldquo;Not yet&rdquo; means the
            adapter is built from the provider&apos;s docs and tested against a mock of its API only.
          </li>
          <li>
            <strong>Docker</strong> runs on your own machine and is only used when you ask for it by name.
          </li>
        </ul>

        <h2 id="fallback">Fallback</h2>
        <p>
          If a provider looks unavailable (a timeout, a network error, 429 or 5xx, or a create that takes longer than{" "}
          <code>createTimeoutSeconds</code>, default 120), the router tries the next candidate. The sandbox you get back lists
          every attempt:
        </p>
        <CodeBlock
          code={`sbx.attempts
// [ { provider: "daytona", ok: false, ms: 212, error: "... 429 too many requests" },
//   { provider: "e2b", ok: true, ms: 840 } ]`}
        />
        <p>
          An account that can&apos;t pay (402: no balance, or a plan needed) also falls back, and stays on{" "}
          <code>attempts</code>. A setup error (400, 401, 403, 404 or 422: a bad key, a bad image or request) stops instead, so a
          mistake isn&apos;t hidden by quietly sending the work to another, maybe pricier, provider. Pass{" "}
          <code>fallback: &quot;any&quot;</code> to fall back on every error, or <code>fallback: false</code> to try only the
          first candidate. If every candidate fails, <code>create</code> throws a <code>RouterError</code> with the same{" "}
          <code>attempts</code>. A sandbox that turns up after its create timed out is killed, or left in the ledger for{" "}
          <code>sandboxrouter gc</code> if that fails. Commands never fall back, because a sandbox&apos;s state lives on one
          provider.
        </p>

        <h2 id="streaming">Streaming output</h2>
        <CodeBlock
          code={`const r = await sbx.exec("npm test", {
  cwd: "/app",
  env: { CI: "1" },
  timeoutSeconds: 600,
  onStdout: (chunk) => process.stdout.write(chunk),
  onStderr: (chunk) => process.stderr.write(chunk),
});
// r still has the full stdout, stderr and exitCode`}
        />
        <p>A nonzero exit code is a result, not an exception. Exceptions mean the provider itself failed.</p>

        <h2 id="files">Files</h2>
        <CodeBlock
          code={`await sbx.writeFile("/tmp/data.csv", "x,y\\n1,2\\n");   // string or Uint8Array
const bytes = await sbx.readFile("/tmp/out.png");
const text = await sbx.readText("/tmp/log.txt");`}
        />

        <h2 id="pause">Pause and resume</h2>
        <p>
          Providers with the pause capability keep a sandbox&apos;s disk (and memory, where they snapshot it) while it&apos;s paused.
          Resume by reattaching with its id.
        </p>
        <CodeBlock
          code={`const sbx = await router.create({}, { require: ["pause"] });
await sbx.pause();
// later, in any process:
const again = await router.get(sbx.id);   // e.g. "e2b:iz5sb5a4bt3pmjx7c5ms2"`}
        />

        <h2 id="computers">Desktops and phones</h2>
        <p>
          For computer-use agents: a machine with a screen that your model drives with clicks and keys. Seven providers offer Linux
          and Windows desktops, Android phones and iPhone simulators; the <a href="/providers#desktops">Desktops table</a> has prices and
          sizes. <code>router.computer({`{ os }`})</code> starts one on the cheapest provider for that OS that you have keys for, ties
          alphabetical. Actions use the Anthropic computer-use shape everywhere, and coordinates are in the last screenshot&apos;s
          frame. Not every provider has a live view or sleep; <code>computer.supports</code> tells you, and calling one that&apos;s
          missing throws a clear error.
        </p>
        <CodeBlock
          code={`const desk = await router.computer({ os: "linux", externalUserId: "user_42" });
const shot = await desk.act({ action: "screenshot" });        // { imageB64, width, height, frameId }
await desk.act({ action: "left_click", coordinate: [412, 230] });
await desk.actBatch([{ action: "type", text: "hello" }, { action: "key", text: "Return" }]);

// A login or CAPTCHA? Give the screen to a person:
const { url } = await desk.viewer("control", { reason: "Please sign in" });`}
        />
        <p>
          The same <code>externalUserId</code> always returns the same computer, with its files and logins. From the terminal:{" "}
          <code>npx @sandboxrouter/sdk desktop --control</code> prints a link to the live screen.
        </p>

        <h2 id="server">HTTP server</h2>
        <p>Any language can use the router over HTTP. Provider keys stay on the server; clients hold one token.</p>
        <CodeBlock
          title="terminal"
          code={`SANDBOXROUTER_TOKEN=secret npx @sandboxrouter/sdk serve --port 8787
# allow a website (like this one's Playground) to call it from the browser (needs the token):
SANDBOXROUTER_TOKEN=secret npx @sandboxrouter/sdk serve --cors https://your-site.example`}
        />
        <TableScroll>
          <table>
            <thead>
              <tr>
                <th>Call</th>
                <th>Body</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["GET /v1/providers", ""],
                ["POST /v1/route", "same as create; returns the candidate order"],
                ["POST /v1/sandboxes", "{ vcpu, memoryGb, gpu, env, timeoutMinutes, image, provider, strategy, fallback, createTimeoutSeconds, require }"],
                ["POST /v1/sandboxes/:id/exec", "{ cmd, cwd, env, timeoutSeconds, stream }"],
                ["PUT /v1/sandboxes/:id/files?path=", "raw bytes"],
                ["GET /v1/sandboxes/:id/files?path=", ""],
                ["POST /v1/sandboxes/:id/pause", ""],
                ["DELETE /v1/sandboxes/:id", ""],
                ["POST /v1/computers", "{ os, externalUserId, screen }"],
                ["POST /v1/computers/:id/actions", "one action or { actions: [...] }"],
                ["GET /v1/computers/:id/screenshot", "image bytes"],
                ["POST /v1/computers/:id/viewer", `{ mode: "watch" | "control" }`],
              ].map(([a, b]) => (
                <tr key={a}>
                  <td className="font-mono text-xs whitespace-nowrap">{a}</td>
                  <td className="font-mono text-xs">{b}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
        <p>
          With <code>stream: true</code>, exec answers <code>text/event-stream</code>: <code>stdout</code> and{" "}
          <code>stderr</code> events carry JSON string chunks, then one <code>result</code> event.
        </p>

        {HOSTED_PUBLIC && (
        <>
        <h2 id="hosted">Hosted key</h2>
        <p>
          The hosted service runs the same HTTP API on sandboxrouter&apos;s own provider accounts, so one key replaces all the provider
          keys. Sign in at <a href={`${HOSTED_URL}/dashboard`}>the dashboard</a>, add credit by card and create a key. Each sandbox
          is billed by the second at its provider&apos;s list price plus {HOSTED_FEE_PCT}%, and the dashboard shows what each one cost.
        </p>
        <CodeBlock
          title="agent.ts"
          code={`import { Client } from "@sandboxrouter/sdk";

const sr = new Client({ baseUrl: "${HOSTED_URL}", apiKey: process.env.SANDBOXROUTER_API_KEY });
const sbx = await sr.create({ vcpu: 2, memoryGb: 4 });
console.log(sbx.provider, (await sbx.exec("echo hi")).stdout);
await sbx.kill();`}
        />
        <p>
          An agent can open an account itself: <code>POST /v1/signup</code> returns a key with no credit and a link its person uses to
          pay and claim the account. The steps are in <a href={`${HOSTED_URL}/auth.md`}>/auth.md</a>. On the hosted API, pause and
          desktops are off for now, and accounts run up to 5 sandboxes at once for up to 4 hours each. See the{" "}
          <a href={`${HOSTED_URL}/terms`}>terms</a> and <a href={`${HOSTED_URL}/refunds`}>refund policy</a>.
        </p>
        </>
        )}

        <h2 id="python">Python</h2>
        <p>
          A client with no dependencies lives in the repo&apos;s <code>python/</code> folder. It talks to the HTTP server.
        </p>
        <CodeBlock
          code={`from sandboxrouter import Client

sr = Client("http://127.0.0.1:8787", token="secret")
with sr.create(strategy="cheapest") as sbx:
    sbx.exec("pip install rich", on_stdout=lambda c: print(c, end=""))
    print(sbx.provider, sbx.estimated_hourly_usd)`}
        />

        <h2 id="bench">Bench and leaderboard</h2>
        <p>
          <code>bench</code> starts real sandboxes on every provider you have keys for, times them, kills them, and prints a
          table. <code>--share</code> also writes a report you can add to the repo&apos;s <code>results/</code> folder in a pull
          request; the <a href="/benchmarks">benchmarks page</a> and the cold-start column in the <a href="/providers">provider table</a> are built from those reports.
        </p>
        <CodeBlock title="terminal" code={`npx @sandboxrouter/sdk bench --runs 5 --share --label "SF, home wifi"`} />
        <p>
          The label says where you ran it, because the network between you and each provider is part of the number. Use a city or
          cloud region, not an address.
        </p>

        <h2 id="providers">Adding a provider</h2>
        <p>
          Implement the <code>Provider</code> interface in <code>src/types.ts</code> (create, connect, exec, files, kill, and pause
          if it&apos;s real), and add a catalog entry with a link to the provider&apos;s pricing page.
          {REPO_PUBLIC && (
            <>
              {" "}
              Pull requests welcome on <a href={REPO}>GitHub</a>.
            </>
          )}
        </p>
      </article>
    </div>
  );
}
