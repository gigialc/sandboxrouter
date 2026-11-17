// What the site serves to agents: /benchmarks.json, /llms.txt, Markdown versions of pages, and the MCP tools.
// Everything comes from the same generated data as the pages (src/data/*.json), and rankings from the same
// recommend() the SDK uses, so an agent and a person reading the site get the same answer.
import published from "@/data/published.json";
import { recommend, type PublishedData, type RecJob, type RecPriority } from "@/lib/recommend";
import { HOSTED_FEE_PCT, HOSTED_URL, NPM, REPO, site } from "@/lib/site";

export const ORIGIN = "https://www.sandboxrouter.ai";
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

/** /benchmarks.json: the published numbers, with what they mean. */
export function benchmarksJson() {
  return {
    ...DATA,
    about: {
      what: "Sandbox provider benchmarks run on real accounts: start time, real jobs priced by each provider's own billing rules, bursts at once, and a real AI agent.",
      methodology: `${ORIGIN}/methodology`,
      page: `${ORIGIN}/benchmarks`,
      rawResults: `${REPO}/tree/main/results`,
      jobs: JOB_TEXT,
      units: "Times in milliseconds (…Ms). Costs in US dollars: taskUsd is one job in a new sandbox (start, minimum charge and per-sandbox fee included), reusedUsd one job in a sandbox already running, usdPer100 a burst's cost per 100 sandboxes.",
      successRate: "Share of runs that worked, with refusals for the benchmarking account's own limits left out.",
      load: "Bursts: n sandboxes asked for at once; ok started; limited refused for the benchmarking account's limit (ours, not the provider's); p50Ms/p99Ms time to ready from the moment all were asked for.",
      recommend: `Rank these for a job with the MCP tool recommend_provider at ${ORIGIN}/mcp, \`npx ${NPM} recommend\`, or recommend() from ${NPM}.`,
    },
    agent: site.agent,
  };
}

const secs = (ms?: number) => (ms === undefined ? "n/a" : ms >= 10_000 ? `${(ms / 1000).toFixed(0)} s` : `${(ms / 1000).toFixed(2)} s`);
const money = (n?: number) => (n === undefined ? "n/a" : n >= 1 ? `$${n.toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(3)}` : `$${n.toPrecision(2)}`);
const table = (head: string[], rows: (string | number)[][]) =>
  [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

/** The Benchmarks page as Markdown, every table in full (the page shows one tab at a time). */
export function benchmarksMarkdown(): string {
  const out: string[] = [
    "# sandboxRouter benchmarks",
    "",
    `Sandbox providers measured on real accounts. Data through ${DATA.dataThrough.slice(0, 10)}. How it's measured: ${ORIGIN}/methodology. Machine-readable: ${ORIGIN}/benchmarks.json. Raw results: ${REPO}/tree/main/results.`,
    "",
    "Rankings are per successful run: a provider whose runs sometimes failed has its cost and time divided by its success rate. Refusals for the benchmarking account's own limits are left out of success rates.",
    "",
    "## Cost and time for a job",
  ];
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
        ["#", "Provider", "Time (start + job)", "Cost per job", "Cost per 1,000", "Success", "Runs", "Value score", "Notes"],
        r.results.map((x) => [x.rank, x.name, secs(x.secondsEach * 1000), money(x.usdEach), money((x.usdEach ?? 0) * 1000), `${Math.round(x.successRate * 100)}%`, x.runs, x.valueScore.toFixed(2), x.notes.join("; ")]),
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
        ["Provider", "Done right", "Session", "Sandbox idle", "Cost per session"],
        agent.map((a) => [
          a.name,
          `${a.ok}/${a.runs}`,
          secs(a.medianWallMs),
          a.medianWallMs && a.medianModelMs ? `${Math.round((a.medianModelMs / a.medianWallMs) * 100)}%` : "n/a",
          money(a.medianUsd),
        ]),
      ),
    );
  }
  out.push("", "## Under load", "", "Sandboxes asked for at once. Time to ready counts from the moment all were asked for. Ranked by median among providers that started all of them; the rest weren't measured at that size, since the benchmarking account's limit (ours, not the provider's) stopped them.");
  for (const l of DATA.load) {
    const rows = Object.entries(l.rows);
    const full = rows.filter(([, r]) => r.ok === r.n).sort(([, a], [, b]) => (a.p50Ms ?? Infinity) - (b.p50Ms ?? Infinity));
    const rest = rows.filter(([, r]) => r.ok < r.n);
    out.push(
      "",
      `### ${l.n} at once: ${LOAD_TEXT[l.job]}`,
      "",
      table(
        ["#", "Provider", "Ready p50", "Ready p99", "All done", "Cost per 100"],
        full.map(([, r], i) => [i + 1, r.name, secs(r.p50Ms), secs(r.p99Ms), secs(r.wallMs), money(r.usdPer100)]),
      ),
    );
    if (rest.length) out.push("", `Not measured at ${l.n} yet: ${rest.map(([, r]) => `${r.name} (${r.ok} of ${r.n} started${r.limited ? `, ${r.limited} refused for our account's limit` : ""})`).join(", ")}.`);
  }
  const start = Object.values(DATA.start).sort((a, b) => a.medianCreateMs - b.medianCreateMs);
  out.push(
    "",
    "## Start time",
    "",
    "Time to a usable sandbox, one at a time.",
    "",
    table(
      ["#", "Provider", "Median start", "Success", "Runs", "Per hour (list)"],
      start.map((s, i) => [i + 1, s.name, secs(s.medianCreateMs), `${Math.round(s.successRate * 100)}%`, s.runs, money(s.hourlyUsd)]),
    ),
    "",
  );
  return out.join("\n");
}

/** /llms.txt: what this is and how an agent should use it. */
export function llmsTxt(): string {
  return `# sandboxRouter

> One API for every sandbox provider for AI agents (${site.providers.length} providers: E2B, Daytona, Modal, Vercel Sandbox, Cloudflare and more). Open-source SDK and CLI (${NPM}), an optional hosted key (${HOSTED_URL}, ${HOSTED_FEE_PCT}% fee, or bring your own provider keys for free), and public benchmarks measured on real accounts.

## When to use sandboxRouter

- **Choosing a sandbox provider.** Use the measured benchmarks below instead of provider marketing: start time, real jobs priced by each provider's own billing rules, 10 and 100 at once, and a real AI agent.
- **Running agent code in a sandbox.** One API over many providers, with fallback when one fails: \`npm i ${NPM}\`.

## How an agent should use it

- **Ask which provider for a job:** MCP endpoint \`${ORIGIN}/mcp\` (Streamable HTTP, no auth), tool \`recommend_provider\` with \`job\` (${JOBS.join(", ")}), \`count\` (sandboxes at once), \`priority\` (${PRIORITIES.join(", ")}). Or \`npx ${NPM} recommend --job python --count 100\`, or \`recommend()\` from the SDK.
- **Read the numbers:** ${ORIGIN}/benchmarks.json (stable schema, field meanings under \`about\`). Raw results for every run: ${REPO}/tree/main/results
- **Read any page as Markdown:** send \`Accept: text/markdown\`, or add \`.md\` to the path (for example ${ORIGIN}/benchmarks.md).
- The SDK's routing already uses these published start times when you haven't benchmarked yourself.

## Pages

- [Benchmarks](${ORIGIN}/benchmarks.md): every table
- [Methodology](${ORIGIN}/methodology.md): how each number is measured and priced
- [Providers](${ORIGIN}/providers.md): prices and features
- [Docs](${ORIGIN}/docs.md): SDK, CLI and hosted API
- [Learn](${ORIGIN}/learn.md): sandboxes for AI agents, explained
- [Security](${ORIGIN}/security.md)
${site.providers
  .filter((p) => !p.local)
  .map((p) => `- [${p.name}](${ORIGIN}/providers/${p.id}.md)`)
  .join("\n")}

## Source

- SDK, CLI and benchmark harness: ${REPO}
- npm: https://www.npmjs.com/package/${NPM}
`;
}

/** A page's main content as Markdown: enough structure (headings, lists, tables, links, code) for an agent. */
export function htmlToMarkdown(html: string, base: string): string {
  let s = html.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? html;
  s = s.replace(/<(script|style|svg|noscript|template|button|nav|form)\b[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  const abs = (href: string) => (href.startsWith("/") ? base + href : href);
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, c) => `\n\n\`\`\`\n${strip(c).trim()}\n\`\`\`\n\n`);
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, c) => `\n\n${"#".repeat(Number(n))} ${inline(c, abs).trim()}\n\n`);
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
    .trim() + "\n";
}

function inline(s: string, abs: (h: string) => string): string {
  return decode(
    s
      .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, h, c) => {
        const text = strip(c).replace(/\s+/g, " ").trim();
        return text ? `[${text}](${abs(h)})` : "";
      })
      .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, c) => `**${strip(c).trim()}**`)
      .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, c) => `\`${strip(c)}\``)
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
      "Which sandbox provider to use for a job, ranked from sandboxRouter's published benchmarks (measured on real accounts). Costs and times are per successful run. For count of 10 or more, start times measured with that many at once are used where available.",
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
    description: "The published benchmark numbers: start time, cost and time per job, bursts at once, and the real-agent test. Same data as /benchmarks.json.",
    inputSchema: {
      type: "object",
      properties: { section: { type: "string", enum: ["start", "jobs", "load", "agent", "all"], description: "Default all." } },
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
    description: "Every sandbox provider sandboxRouter supports: id, name, list price per hour at 2 vCPU / 4 GB, and whether it's benchmarked.",
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
    if (!["start", "jobs", "load"].includes(section)) throw new ToolError("section must be one of start, jobs, load, agent, all");
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
