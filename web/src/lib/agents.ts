// What the site serves to agents: /benchmarks.json, /llms.txt, Markdown versions of pages, and the MCP tools.
// Everything comes from the same generated data as the pages (src/data/*.json), and rankings from the same
// recommend() the SDK uses, so an agent and a person reading the site get the same answer.
import published from "@/data/published.json";
import { recommend, type PublishedData, type RecJob, type RecPriority } from "@/lib/recommend";
import { HOSTED_FEE_PCT, HOSTED_URL, NPM, NPM_URL, OWN_IMAGE_NOTE, REPO, RESULTS_REF, needsOwnImage, shapeLabel, site } from "@/lib/site";
import { markdownPath, ORIGIN, publicPages } from "@/lib/public-pages";

export const DATA = published as PublishedData;
export const JOBS = ["start", "short", "long", "python", "download", "agent", "repo"] as const satisfies readonly RecJob[];
export const PRIORITIES = ["value", "cost", "speed"] as const satisfies readonly RecPriority[];

const JOB_TEXT: Record<RecJob, string> = {
  start: "Start a sandbox and run one command.",
  short: "Hashing on one and two cores, then a 256 MB disk write: a few seconds.",
  long: "The short job 40 times in a row: minutes of steady work.",
  python: "A 1 to 2 second pure-Python script, like one code-interpreter call.",
  download: "A 53 MB download over HTTPS.",
  agent: "An agent loop: 10 turns of a 6 s model wait and a short Python tool call; about a minute, mostly idle.",
  repo: "What a coding agent does first: fetch Node 22 and a pinned real TypeScript project, npm ci, typecheck.",
};
const LOAD_TEXT = { start: "Start only", rl: "Quick Python runs (the 1 to 2 second Python job each)", agents: "Parallel agents (the agent loop each)" };
/** The plan-dependent start fees the numbers leave out, as one sentence naming every provider that has one. */
const START_FEES = Object.entries(DATA.conditionalStartFees ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([id, fee]) => ({
  name: site.providers.find((p) => p.id === id)?.name ?? id,
  amount: fee.minUsd === fee.maxUsd ? `$${fee.minUsd.toFixed(2)}` : `$${fee.minUsd.toFixed(2)}–$${fee.maxUsd.toFixed(2)}`,
  when: fee.when ?? "above its included allowances",
  source: fee.source,
}));
const START_FEE_TEXT = START_FEES.length
  ? `Estimates exclude start fees that depend on your plan: ${START_FEES.map((f) => `${f.name} charges ${f.amount} per start ${f.when}`).join("; ")}.`
  : "";
const START_FEE_MARKDOWN = START_FEES.length
  ? `Estimates exclude start fees that depend on your plan: ${START_FEES.map((f) => `[${f.name} charges ${f.amount} per start ${f.when}](${f.source})`).join("; ")}.`
  : "";
const BILL_DATA_THROUGH = [
  ...site.costRuns.map((r) => r.settledAt ?? r.date),
  ...site.hostedCosts.map((r) => r.checkedAt ?? r.date),
].sort().at(-1) ?? null;

/** /benchmarks.json: the published numbers, with what they mean. */
export function benchmarksJson() {
  return {
    ...DATA,
    about: {
      what: "Sandbox provider create timings, request bursts, verified workload results, and billing evidence.",
      methodology: `${ORIGIN}/methodology`,
      page: `${ORIGIN}/benchmarks`,
      rawResults: `${REPO}/tree/${RESULTS_REF}/results`,
      jobs: JOB_TEXT,
      units: `Times in milliseconds (…Ms). Costs in US dollars: taskUsd is one job in a new sandbox (start and minimum charge included), reusedUsd one job in a sandbox already running, usdPer100 a burst's estimated cost per 100 sandboxes. ${START_FEE_TEXT} They are listed in conditionalStartFees.`,
      successRate: "For tasks, completed workloads divided by all requests. Create observations exclude recorded limit refusals from that rate.",
      load: "Bursts: n requests, ok verified completions (first command, and workload if applicable), limited reported limit refusals, p50Ms/p99Ms readiness among completions.",
      archive: "The raw results include older workload reports. Only current, verified workloads are ranked in this feed.",
      bills: "Vendor metered usage and provider estimates are typed separately. Hosted charges are SandboxRouter credit debits. USD values preserve up to six decimals. Where present, billResolutionUsd is the source's precision.",
      recommend: `Rank the current benchmark data with the MCP tool recommend_provider at ${ORIGIN}/mcp. The npm CLI uses the benchmark snapshot bundled with its installed version.`,
    },
    useCases: site.useCases,
    agent: site.agent,
    bills: { dataThrough: BILL_DATA_THROUGH, provider: site.costRuns, hosted: site.hostedCosts },
  };
}

/** All provider table views, including sizes and operating systems hidden behind browser controls. */
export function providersJson() {
  return {
    about: {
      page: `${ORIGIN}/providers`,
      methodology: `${ORIGIN}/methodology#pricing`,
      currency: "USD",
      units: "Sandbox prices are hourly list rates by reference shape. Active CPU rates assume full utilization. Unfit entries identify unsupported shapes. ownImage marks a size above the provider's default image, priced at that size, which needs your own image or template; defaultSize has the default image's size and hourly price. Desktop rates are hourly where available. Price index lines are estimated direct-provider scenario costs.",
    },
    shapes: site.shapes.map((id) => ({ id, label: shapeLabel(id) })),
    providers: site.providers.map((p) => ({
      id: p.id,
      name: p.name,
      page: `${ORIGIN}/providers/${p.id}`,
      markdown: `${ORIGIN}/providers/${p.id}.md`,
      docs: p.docs,
      local: p.local ?? false,
      capabilities: p.capabilities,
      limits: p.limits,
      pricing: p.pricing,
      billing: p.billing,
      billedVsList: p.billedVsList,
      prices: p.prices,
      defaultSize: p.defaultSize,
      plan: p.plan,
      access: p.access,
      live: p.live,
    })),
    desktops: site.desktops,
    priceIndex: site.priceIndex,
  };
}

const secs = (ms?: number) => (ms === undefined ? "n/a" : ms >= 10_000 ? `${(ms / 1000).toFixed(0)} s` : `${(ms / 1000).toFixed(2)} s`);
const money = (n?: number) => (n === undefined ? "n/a" : n >= 1 ? `$${n.toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(3)}` : `$${n.toPrecision(2)}`);
/** The size a row was measured at; every table carries it so a smaller machine is never read as 2 vCPU / 4 GB. */
const sizeCell = (size?: { vcpu: number; memoryGb: number }) => (size ? `${size.vcpu} vCPU / ${size.memoryGb} GB` : "2 vCPU / 4 GB");
const table = (head: string[], rows: (string | number)[][]) =>
  [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

/** The Benchmarks page as Markdown, every table in full (the page shows one tab at a time). */
export function benchmarksMarkdown(): string {
  const out: string[] = [
    "# sandboxRouter benchmarks",
    "",
    `Sandbox providers measured on real accounts. Data through ${DATA.dataThrough.slice(0, 10)}. How it's measured: ${ORIGIN}/methodology. Machine-readable: ${ORIGIN}/benchmarks.json. Raw results: ${REPO}/tree/${RESULTS_REF}/results.`,
    "",
    "Task rankings divide estimated time and cost by the share of requests that succeeded. Older workload and real-agent results are available in the raw archive. New rankings require the current verification versions.",
    "",
    START_FEE_MARKDOWN,
    "",
    "## Estimated cost for common scenarios",
  ];
  for (const scenario of site.useCases) {
    const { vcpu, memoryGb, cpuUtilization } = scenario.spec;
    const size = `${vcpu} vCPU / ${memoryGb} GB, ${scenario.runSeconds} s`;
    out.push(
      "",
      `### ${scenario.title}`,
      "",
      `${scenario.blurb} ${size}${cpuUtilization === undefined ? "" : `, ${cpuUtilization * 100}% CPU assumed`}.`,
      "",
      table(
        ["Provider", "Est. per run", "Est. per 1,000 runs", "Notes"],
        scenario.top.map((r) => [r.name, money(r.runUsd), money(r.runUsd * 1000), r.ownImage ? OWN_IMAGE_NOTE : ""]),
      ),
    );
  }
  out.push("", "## Cost and time for a measured job");
  if (!Object.keys(DATA.jobs).length) out.push("", "No results have been published with the new workload checks yet.");
  for (const job of JOBS.filter((j) => j !== "start")) {
    const r = recommend(DATA, { job, priority: "value" });
    if (!r.results.length) continue;
    out.push(
      "",
      `### ${job}`,
      "",
      JOB_TEXT[job] + " Each job in its own new sandbox; ranked by best value (cost times time, each against the median).",
      "",
      table(
        ["#", "Provider", "Size", "Time (start + job)", "Cost per job", "Cost per 1,000", "Success", "Runs", "Value score", "Notes"],
        r.results.map((x) => [x.rank, x.name, sizeCell(x.size), secs(x.secondsEach * 1000), money(x.usdEach), money((x.usdEach ?? 0) * 1000), `${Math.round(x.successRate * 100)}%`, x.runs, x.valueScore.toFixed(2),
          [...(needsOwnImage(x.provider, x.size ?? { vcpu: 2, memoryGb: 4 }) ? [OWN_IMAGE_NOTE] : []), ...x.notes].join("; ")]),
      ),
    );
  }
  const agent = site.agent;
  if (agent.length) {
    out.push(
      "",
      "## A real AI agent",
      "",
      `A real model (${agent[0].model ?? "Gemini"}) does the same task in a sandbox on each provider, with one shell tool; the result is checked inside the sandbox.`,
      "",
      table(
        ["Provider", "Size", "Done right", "Session", "Sandbox idle", "Cost per session"],
        agent.map((a) => [
          a.name,
          sizeCell(a.size),
          `${a.ok}/${a.requested ?? a.runs}`,
          secs(a.medianWallMs),
          a.medianWallMs && a.medianModelMs ? `${Math.round((a.medianModelMs / a.medianWallMs) * 100)}%` : "n/a",
          money(a.medianUsd),
        ]),
      ),
    );
  }
  out.push("", "## Under load", "", "Readiness measures time from the batch request to each successful first command. Only complete batches receive latency ranks and scaled cost estimates.");
  for (const l of DATA.load) {
    const rows = Object.entries(l.rows);
    const full = rows.filter(([, r]) => r.ok === r.n).sort(([, a], [, b]) => (a.p50Ms ?? Infinity) - (b.p50Ms ?? Infinity));
    const rest = rows.filter(([, r]) => r.ok < r.n);
    out.push(
      "",
      `### ${l.n} at once: ${LOAD_TEXT[l.job]}`,
      "",
      table(
        ["#", "Provider", "Size", "Ready p50", "Ready p99", "Last outcome", "Est. cost per 100"],
        full.map(([, r], i) => [i + 1, r.name, sizeCell(r.size), secs(r.p50Ms), secs(r.p99Ms), secs(r.wallMs), money(r.usdPer100)]),
      ),
    );
    if (rest.length) out.push("", `Incomplete: ${rest.map(([, r]) => `${r.name} (${r.ok} of ${r.n} completed, ${r.limited} reported limit refusals, ${r.n - r.ok - r.limited} other failures)`).join(", ")}.`);
  }
  const start = Object.values(DATA.start).sort((a, b) => a.medianCreateMs - b.medianCreateMs);
  out.push(
    "",
    "## Start time",
    "",
    "Median create response, one request at a time, at the size shown. The first command is measured separately. Per hour is the list price at that size.",
    "",
    table(
      ["#", "Provider", "Size", "Median create", "Success (limits excluded)", "Runs", "Per hour (list)"],
      start.map((s, i) => [i + 1, s.name, sizeCell(s.size), secs(s.medianCreateMs), `${Math.round(s.successRate * 100)}%`, s.runs, money(s.hourlyUsd)]),
    ),
    "",
  );
  const usage = site.costRuns.filter((r) => !r.error && r.billKind === "provider-usage");
  const billLink = (file: string) => `[record](${REPO}/blob/${RESULTS_REF}/results/cost/${encodeURIComponent(file)})`;
  const billUsd = (n: number | null, resolution?: number | null) => n === null ? "—" : `$${n.toFixed(resolution === 0.01 ? 2 : 6)}`;
  if (usage.length) out.push(
    "## Provider-reported usage",
    "",
    "The list estimate uses end-to-end time. A whole-cent zero lacks the precision to test a sub-cent estimate.",
    "",
    table(
      ["Provider", "Date (UTC)", "Wall time", "List estimate", "Reported usage", "Report precision", "Evidence"],
      usage.map((r) => [r.name, r.date.slice(0, 10), r.seconds === null ? "—" : `${r.seconds} s`,
        billUsd(r.predictedUsd), billUsd(r.billedUsd, r.billResolutionUsd), r.billResolutionUsd === 0.01 ? "Whole cents" : "—", billLink(r.file)]),
    ),
    "",
  );
  if (site.hostedCosts.length) out.push(
    "## SandboxRouter hosted charges",
    "",
    "These are debits from a funded SandboxRouter key. Runtime quotes use the observed elapsed time.",
    "",
    table(
      ["Provider", "Original duration", "Recorded runtime", "Original quote", "Runtime quote", "Ledger debit", "Evidence"],
      site.hostedCosts.map((r) => [r.name, `${r.expectedSeconds} s`, `${r.runtimeSeconds} s`, billUsd(r.quoteUsd),
        billUsd(r.quoteAtRecordedRuntimeUsd ?? null), billUsd(r.chargeUsd), billLink(r.file)]),
    ),
    "",
  );
  return out.join("\n");
}

/** /llms.txt: what this is and how an agent should use it. */
export function llmsTxt(): string {
  return `# sandboxRouter

> One API for every sandbox provider for AI agents (${site.providers.filter((p) => !p.local).length} hosted providers, plus local Docker: E2B, Daytona, Modal, Vercel Sandbox, Cloudflare and more). Open-source SDK and CLI (${NPM}), an optional hosted key (${HOSTED_URL}, ${HOSTED_FEE_PCT}% fee, or bring your own provider keys for free), and public benchmarks measured on real accounts.

## When to use sandboxRouter

- **Choosing a sandbox provider.** Compare create timings and request bursts. The benchmark archive contains older workload and real-agent results. Workload rankings require the newer verification scripts. ${START_FEE_TEXT}
- **Running agent code in a sandbox.** One API over many providers; if one can't start a sandbox, the next one does: \`npm i ${NPM}\`.

## How an agent should use it

- **Ask which provider for a job:** MCP endpoint \`${ORIGIN}/mcp\` (Streamable HTTP, no auth), tool \`recommend_provider\` with \`job\` (${JOBS.join(", ")}), \`count\` (sandboxes at once), \`priority\` (${PRIORITIES.join(", ")}). Or \`npx ${NPM} recommend --job python --count 100\`, or \`recommend()\` from the SDK.
- [Benchmarks JSON](${ORIGIN}/benchmarks.json): published measurements, modelled scenarios, and billing evidence.
- [Provider catalog JSON](${ORIGIN}/providers.json): every sandbox size and desktop OS, billing rules, and the price index.
- [OpenAPI specification](${ORIGIN}/openapi.json): schemas for the public read-only data endpoints.
- [Raw benchmark results](${REPO}/tree/${RESULTS_REF}/results): evidence from individual runs.
- **Read pages as Markdown:** request a link below, or request the canonical HTML URL with \`Accept: text/markdown\`. MCP clients can also list and read these pages as resources.
- The SDK's routing already uses these published start times when you haven't benchmarked yourself.

## Pages

${publicPages.map(({ path, title, description }) => `- [${title}](${ORIGIN}${markdownPath(path)}): ${description}`).join("\n")}

## Source

- SDK, CLI and benchmark harness: ${REPO}
- [SandboxRouter SDK and CLI on npm](${NPM_URL})
`;
}

/** A page's main content as Markdown: enough structure (headings, lists, tables, links, code) for an agent. */
export function htmlToMarkdown(html: string, base: string): string {
  let s = html.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? html;
  // storm-scene is the front page's interactive scene: nothing in it is content, so agents don't get its controls and captions.
  s = s.replace(/<(script|style|svg|noscript|template|button|nav|form|storm-scene)\b[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  const abs = (href: string) => {
    try {
      return new URL(decode(href), base).href;
    } catch {
      return href;
    }
  };
  const codeBlocks: string[] = [];
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, content) => {
    const code = strip(content).replace(/^\n|\n$/g, "");
    const fence = "`".repeat(Math.max(3, ...Array.from(code.matchAll(/`+/g), (m) => m[0].length + 1)));
    const index = codeBlocks.push(`${fence}\n${code}\n${fence}`) - 1;
    return `\n\n\u0000${index}\u0000\n\n`;
  });
  s = s.replace(/<\/a>\s*<a(?=\s)/gi, "</a> <a");
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, c) => `\n\n${"#".repeat(Number(n))} ${inline(c.replace(/<br\s*\/?>/gi, " "), abs).replace(/\s+/g, " ").trim()}\n\n`);
  s = s.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, t) => {
    const rows = [...t.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) =>
      [...m[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => inline(c[1], abs).replace(/\s+/g, " ").replace(/\|/g, "\\|").trim()),
    );
    if (!rows.length) return "";
    const w = Math.max(...rows.map((r) => r.length));
    const line = (r: string[]) => `| ${[...r, ...Array(w - r.length).fill("")].join(" | ")} |`;
    return `\n\n${line(rows[0])}\n|${Array(w).fill("---").join("|")}|\n${rows.slice(1).map(line).join("\n")}\n\n`;
  });
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, c) => `\n- ${inline(c, abs).replace(/\s+/g, " ").trim()}`);
  s = s.replace(/<(p|div|section|ul|ol|dl|dt|dd|header|footer|article|aside|figure|figcaption|br)\b[^>]*>/gi, "\n\n");
  s = inline(s, abs);
  return s
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replace(/\u0000(\d+)\u0000/g, (_, index) => codeBlocks[Number(index)]) + "\n";
}

function inline(s: string, abs: (h: string) => string): string {
  return decode(
    s
      .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, h, c) => {
        const text = c.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
        return text ? `[${text}](${abs(h)})` : "";
      })
      .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, c) => `**${c.trim()}**`)
      .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, c) => `\`${c}\``)
      .replace(/<[^>]+>/g, ""),
  );
}
const strip = (s: string) => decode(s.replace(/<[^>]+>/g, ""));
const decode = (s: string) =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");

// ---- MCP tools ----

type Json = Record<string, unknown>;
export const MCP_TOOLS = [
  {
    name: "recommend_provider",
    description:
      "Compare providers using current benchmark results. Workload rankings require verified results. Batch measurements supplement single-request timings where available.",
    inputSchema: {
      type: "object",
      properties: {
        job: { type: "string", enum: JOBS, description: Object.entries(JOB_TEXT).map(([k, v]) => `${k}: ${v}`).join(" ") },
        count: { type: "integer", minimum: 1, description: "How many sandboxes at once. Default 1." },
        priority: { type: "string", enum: PRIORITIES, description: "value: cost and time together (default); cost: cheapest; speed: fastest." },
        reuse: { type: "boolean", description: "Jobs run in a sandbox that's already running (no start, minimum or per-sandbox fee). Default false." },
        providers: { type: "array", items: { type: "string" }, description: "Only these provider ids (for example the ones you have keys for)." },
        limit: { type: "integer", minimum: 1, description: "How many to return. Default 5." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_benchmarks",
    description: "The published benchmark numbers: start time, cost and time per job, bursts at once, real-agent tests, and billing evidence. Same data as /benchmarks.json.",
    inputSchema: {
      type: "object",
      properties: { section: { type: "string", enum: ["start", "jobs", "load", "agent", "bills", "all"], description: "Default all." } },
      additionalProperties: false,
    },
  },
  {
    name: "get_provider",
    description: "One provider: pricing and billing rules, features, limits, docs link, and its benchmark numbers.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "Provider id, for example e2b. list_providers gives them." } }, required: ["id"], additionalProperties: false },
  },
  {
    name: "list_providers",
    description: "Cloud sandbox provider IDs, names, and benchmark availability. For all prices and sizes, read /providers.json.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
] as const;

export class ToolError extends Error {}

export function callTool(name: string, args: Json): Json {
  if (name === "recommend_provider") {
    const job = (args.job ?? "short") as RecJob;
    const priority = (args.priority ?? "value") as RecPriority;
    if (!JOBS.includes(job as (typeof JOBS)[number])) throw new ToolError(`job must be one of ${JOBS.join(", ")}`);
    if (!PRIORITIES.includes(priority as (typeof PRIORITIES)[number])) throw new ToolError(`priority must be one of ${PRIORITIES.join(", ")}`);
    const count = args.count === undefined ? 1 : Number(args.count);
    if (!Number.isInteger(count) || count < 1) throw new ToolError("count must be a whole number, 1 or more");
    const providers = Array.isArray(args.providers) ? args.providers.map(String) : undefined;
    const r = recommend(DATA, { job, count, priority, reuse: !!args.reuse, providers, limit: Number(args.limit ?? 5) || 5 });
    return { ...r, methodology: `${ORIGIN}/methodology` } as unknown as Json;
  }
  if (name === "get_benchmarks") {
    const section = String(args.section ?? "all");
    const all = benchmarksJson() as unknown as Json;
    if (section === "all") return all;
    if (section === "agent") return { agent: site.agent, dataThrough: DATA.dataThrough };
    if (section === "bills") return { bills: all.bills, dataThrough: BILL_DATA_THROUGH, about: all.about };
    if (!["start", "jobs", "load"].includes(section)) throw new ToolError("section must be one of start, jobs, load, agent, bills, all");
    return { [section]: all[section], dataThrough: DATA.dataThrough, about: all.about };
  }
  if (name === "get_provider") {
    const id = String(args.id ?? "");
    const p = site.providers.find((x) => x.id === id);
    if (!p) throw new ToolError(`unknown provider "${id}"; list_providers gives the ids`);
    return {
      ...p,
      page: `${ORIGIN}/providers/${id}`,
      benchmarks: {
        start: DATA.start[id],
        jobs: Object.fromEntries(Object.entries(DATA.jobs).flatMap(([j, rows]) => (rows?.[id] ? [[j, rows[id]]] : []))),
        load: DATA.load.flatMap((l) => (l.rows[id] ? [{ job: l.job, ...l.rows[id] }] : [])),
        agent: site.agent.find((a) => a.provider === id),
      },
    } as unknown as Json;
  }
  if (name === "list_providers") {
    return {
      providers: site.providers
        .filter((p) => !p.local)
        .map((p) => ({ id: p.id, name: p.name, benchmarked: !!DATA.start[p.id] || Object.values(DATA.jobs).some((rows) => rows?.[p.id]) })),
    };
  }
  throw new ToolError(`unknown tool "${name}"`);
}
