import { benchmarksJson, callTool, DATA, llmsTxt, MCP_TOOLS, providersJson, ToolError } from "@/lib/agents";
import { readPageMarkdown } from "@/lib/page-markdown";
import { MARKDOWN, markdownPath, ORIGIN, publicPages } from "@/lib/public-pages";
import { site } from "@/lib/site";

// A public, read-only MCP server (Streamable HTTP, stateless, JSON responses) over the published benchmarks:
// agents can ask which sandbox provider to use for a job. No auth: everything here is public data.
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, mcp-protocol-version, mcp-session-id, authorization",
  "access-control-allow-methods": "POST, OPTIONS",
};

type Msg = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
const ok = (id: Msg["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const fail = (id: Msg["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

const dataResources = [
  { path: "/llms.txt", name: "Agent index", mimeType: "text/plain", read: llmsTxt },
  { path: "/benchmarks.json", name: "Benchmark data", mimeType: "application/json", read: () => JSON.stringify(benchmarksJson()) },
  { path: "/providers.json", name: "Provider catalog", mimeType: "application/json", read: () => JSON.stringify(providersJson()) },
];

const resources = [
  ...dataResources.map(({ path, name, mimeType }) => ({ uri: `${ORIGIN}${path}`, name, mimeType })),
  ...publicPages.map(({ path, title, description }) => ({
    uri: `${ORIGIN}${markdownPath(path)}`,
    name: title,
    description,
    mimeType: MARKDOWN,
  })),
];

async function handle(m: Msg, requestUrl: string) {
  if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") return fail(m?.id, -32600, "Invalid request");
  // Notifications (no id) get no response.
  if (m.id === undefined) return undefined;
  switch (m.method) {
    case "initialize": {
      const asked = String(m.params?.protocolVersion ?? "");
      return ok(m.id, {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
        serverInfo: { name: "sandboxrouter-benchmarks", title: "sandboxRouter benchmarks", version: String(site.version) },
        instructions: `Sandbox provider benchmarks measured on real accounts (data through ${DATA.dataThrough.slice(0, 10)}). Use recommend_provider to pick a provider for a job; costs and times are per successful run. Methodology: ${ORIGIN}/methodology`,
      });
    }
    case "ping":
      return ok(m.id, {});
    case "tools/list":
      return ok(m.id, { tools: MCP_TOOLS });
    case "tools/call": {
      const name = String(m.params?.name ?? "");
      if (!MCP_TOOLS.some((t) => t.name === name)) return fail(m.id, -32602, `Unknown tool: ${name}`);
      try {
        const result = callTool(name, (m.params?.arguments ?? {}) as Record<string, unknown>);
        return ok(m.id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result });
      } catch (e) {
        if (e instanceof ToolError) return ok(m.id, { content: [{ type: "text", text: e.message }], isError: true });
        throw e;
      }
    }
    case "resources/list":
      return ok(m.id, { resources });
    case "resources/read": {
      const uri = m.params?.uri;
      const resource = resources.find((entry) => entry.uri === uri);
      if (!resource) return fail(m.id, -32002, "Resource not found");
      const data = dataResources.find(({ path }) => `${ORIGIN}${path}` === uri);
      if (data) return ok(m.id, { contents: [{ uri, mimeType: data.mimeType, text: data.read() }] });

      const page = publicPages.find(({ path }) => `${ORIGIN}${markdownPath(path)}` === uri);
      if (!page) return fail(m.id, -32002, "Resource not found");
      const { body, status } = await readPageMarkdown(page.path, requestUrl);
      if (status !== 200) return fail(m.id, -32603, "Page temporarily unavailable");
      return ok(m.id, { contents: [{ uri, mimeType: MARKDOWN, text: body }] });
    }
    case "prompts/list":
      return ok(m.id, { prompts: [] });
    default:
      return fail(m.id, -32601, `Method not found: ${m.method}`);
  }
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(fail(null, -32700, "Parse error"), { status: 400, headers: CORS });
  }
  const msgs = Array.isArray(body) ? body : [body];
  const out = (await Promise.all(msgs.map((m) => handle(m as Msg, req.url)))).filter((r) => r !== undefined);
  if (!out.length) return new Response(null, { status: 202, headers: CORS });
  return Response.json(Array.isArray(body) ? out : out[0], { headers: CORS });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

// No server-to-client stream: this server only answers requests.
export function GET() {
  return new Response("This MCP endpoint takes POST (Streamable HTTP). See https://www.sandboxrouter.ai/llms.txt", {
    status: 405,
    headers: { ...CORS, allow: "POST, OPTIONS" },
  });
}
