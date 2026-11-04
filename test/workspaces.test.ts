import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WorkspacesAgentProvider } from "../src/providers/workspaces.js";

/**
 * Stand-in for the agent access MCP server (Streamable HTTP JSON-RPC), per
 * docs.aws.amazon.com/appstream2/latest/developerguide/agent-access-mcp-server-*.html.
 */

/** A PNG header with IHDR width 1280, height 720. */
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 5, 0, 0, 0, 2, 0xd0, 8, 2, 0, 0, 0,
]);

const TOOLS = [
  "screenshot", "left_click", "double_click", "triple_click", "right_click", "middle_click", "left_click_drag",
  "left_mouse_down", "left_mouse_up", "move_pointer", "scroll", "type_text", "key", "hold_key", "get_session_info",
].map((n) => ({ name: `agentaccess___${n}`, inputSchema: { type: "object" } }));

type Req = { method: string; headers: IncomingHttpHeaders; body?: any };
let mock: Server;
let endpoint = "";
let reqs: Req[] = [];
let sessions = new Set<string>();
let nextSession = 1;
let toolListsUntilReady = 0;

const calls = () => reqs.filter((r) => r.body?.method === "tools/call").map((r) => [r.body.params.name.replace("agentaccess___", ""), r.body.params.arguments]);

beforeAll(async () => {
  mock = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : undefined;
    reqs.push({ method: req.method!, headers: req.headers, body });
    const json = (status: number, obj: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(obj));
    };
    const auth = String(req.headers.authorization ?? "");
    if (!auth.startsWith("AWS4-HMAC-SHA256 Credential=AKIDTEST/") || !auth.includes("/us-east-1/agentaccess-mcp/aws4_request") || !req.headers["x-amz-date"]) {
      return json(403, { message: "missing SigV4" });
    }
    if (req.url !== "/mcp") return json(404, { message: "no route" });
    if (req.headers["x-amzn-agentaccess-workspaces-applications-stack"] !== "agents") return json(400, { message: "DCV proxy not initialized" });
    const sid = req.headers["mcp-session-id"] as string | undefined;

    if (req.method === "DELETE") {
      if (!sid || !sessions.has(sid)) return json(404, { message: "no session" });
      sessions.delete(sid);
      res.writeHead(200);
      return res.end();
    }
    if (body.method === "initialize") {
      const id = `mcp-${nextSession++}`;
      sessions.add(id);
      return json(200, { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "agentaccess" } } }, { "Mcp-Session-Id": id });
    }
    if (!sid || !sessions.has(sid)) return json(404, { jsonrpc: "2.0", id: body.id, error: { code: -32001, message: "Session not found" } });
    if (body.method === "notifications/initialized") {
      res.writeHead(202);
      return res.end();
    }
    if (body.method === "tools/list") {
      if (toolListsUntilReady > 0) {
        toolListsUntilReady--;
        return json(200, { jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "dcv session not ready" } });
      }
      return json(200, { jsonrpc: "2.0", id: body.id, result: { tools: TOOLS } });
    }
    if (body.method === "tools/call") {
      const name: string = body.params.name;
      const known = TOOLS.some((t) => t.name === name);
      let result: unknown = { content: [{ type: "text", text: "OK" }] };
      if (!known) result = { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
      else if (name === "agentaccess___screenshot") result = { content: [{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" }] };
      else if (name === "agentaccess___get_session_info") {
        result = {
          content: [{ type: "text", text: JSON.stringify({ mcpSessionId: sid, stack: "agents", userId: req.headers["x-amzn-agentaccess-workspaces-applications-user-id"] ?? "iam-user", workSpacesSessionId: "ws-1", fleet: "fleet-1" }) }],
          _meta: { streaming_url: "https://appstream2.us-east-1.aws.amazon.com/authenticate?parameters=abc" },
        };
      } else if (name === "agentaccess___key" && body.params.arguments.keys === "bogus") {
        result = { content: [{ type: "text", text: "SERVER_ERROR: Invalid input" }], isError: true };
      }
      // type_text answers over SSE, with a progress notification first.
      if (name === "agentaccess___type_text") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })}\n\n`);
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`);
        return res.end();
      }
      return json(200, { jsonrpc: "2.0", id: body.id, result });
    }
    json(200, { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
  });
  await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
  endpoint = `http://127.0.0.1:${(mock.address() as { port: number }).port}/mcp`;
});
afterAll(() => mock.close());
beforeEach(() => {
  reqs = [];
  toolListsUntilReady = 0;
});

const provider = (extra: Record<string, unknown> = {}) =>
  new WorkspacesAgentProvider({
    region: "us-east-1",
    stack: "agents",
    fleet: "fleet-1",
    os: "windows",
    endpoint,
    credentials: { accessKeyId: "AKIDTEST", secretAccessKey: "secret" },
    pollMs: 5,
    ...extra,
  });

describe("WorkSpaces agent access computers", () => {
  it("is configured by region + stack + fleet and offers the fleet's OS", () => {
    expect(new WorkspacesAgentProvider({ region: "us-east-1", stack: "s" }).configured()).toBe(false);
    expect(provider().configured()).toBe(true);
    expect(provider().computerOs).toEqual(["windows"]);
    expect(provider({ os: "linux" }).computerOs).toEqual(["linux"]);
  });

  it("starts a session with initialize, signed, with stack and user headers, waiting for the desktop", async () => {
    toolListsUntilReady = 2;
    const c = await provider().createComputer({ os: "windows", externalUserId: "agent-7" });
    expect(c.nativeId).toMatch(/^mcp-\d+~agent-7$/);
    const methods = reqs.map((r) => r.body?.method ?? r.method);
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/list", "tools/list"]);
    const init = reqs[0];
    expect(init.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/us-east-1\/agentaccess-mcp\/aws4_request, SignedHeaders=.*host/);
    expect(init.headers["x-amzn-agentaccess-workspaces-applications-user-id"]).toBe("agent-7");
    expect(init.headers["mcp-session-id"]).toBeUndefined();
    expect(reqs[2].headers["mcp-session-id"]).toBe(c.nativeId.split("~")[0]);
    expect(reqs[2].headers["mcp-protocol-version"]).toBe("2025-06-18");
    expect(reqs.every((r) => String(r.headers.authorization).startsWith("AWS4-HMAC-SHA256"))).toBe(true);

    const info = await c.info();
    expect(info).toMatchObject({ id: c.nativeId, os: "windows", status: "ready", screen: { width: 1280, height: 720 }, externalUserId: "agent-7" });
    await c.delete();
  });

  it("hashes user ids AppStream would reject and omits the header without one", async () => {
    const a = await provider().createComputer({ externalUserId: "user with spaces!" });
    expect(a.nativeId).toMatch(/~sbr-[0-9a-f]{40}$/);
    const b = await provider().createComputer({});
    expect(b.nativeId).toMatch(/^mcp-\d+$/);
    expect(reqs.at(-1)!.headers["x-amzn-agentaccess-workspaces-applications-user-id"]).toBeUndefined();
    await a.delete();
    await b.delete();
  });

  it("maps canonical actions to the agent access tools and returns a fresh screenshot", async () => {
    const c = await provider().createComputer({ externalUserId: "u1" });
    reqs = [];

    const shot = await c.act({ action: "screenshot" });
    expect(shot).toMatchObject({ action: "screenshot", ok: true, mime: "image/png", width: 1280, height: 720, frameId: 1 });
    expect(Buffer.from(shot.imageB64!, "base64").equals(PNG)).toBe(true);

    const click = await c.act({ action: "left_click", coordinate: [412.4, 230], modifier: "Control+shift" });
    expect(click.ok).toBe(true);
    expect(click.imageB64).toBeDefined();
    await c.act({ action: "double_click", coordinate: [5, 6], noScreenshot: true });
    await c.act({ action: "right_click", noScreenshot: true }); // at the last pointer position
    await c.act({ action: "type", text: "hello", noScreenshot: true });
    await c.act({ action: "key", text: "ctrl+a Delete", repeat: 2, noScreenshot: true });
    await c.act({ action: "scroll", coordinate: [640, 360], scrollDirection: "up", scrollAmount: 2, noScreenshot: true });
    const drag = await c.act({ action: "left_click_drag", startCoordinate: [10, 20], coordinate: [300, 400], noScreenshot: true });
    expect(drag).toEqual({ action: "left_click_drag", ok: true });
    await c.act({ action: "mouse_move", coordinate: [7, 8], noScreenshot: true });
    await c.act({ action: "hold_key", text: "shift", duration: 2, noScreenshot: true });
    const pos = await c.act({ action: "cursor_position", noScreenshot: true });
    expect(pos.coordinate).toEqual([7, 8]);

    expect(calls()).toEqual([
      ["screenshot", {}],
      ["left_click", { x: 412, y: 230, modifiers: "ctrl+shift" }],
      ["screenshot", {}],
      ["double_click", { x: 5, y: 6 }],
      ["right_click", { x: 5, y: 6 }],
      ["type_text", { text: "hello" }],
      ["key", { keys: "ctrl+a" }],
      ["key", { keys: "Delete" }],
      ["key", { keys: "ctrl+a" }],
      ["key", { keys: "Delete" }],
      ["scroll", { x: 640, y: 360, scroll_direction: "Up", scroll_amount: 240 }],
      ["left_click_drag", { start_x: 10, start_y: 20, end_x: 300, end_y: 400 }],
      ["move_pointer", { x: 7, y: 8 }],
      ["hold_key", { keys: "shift", duration: 2 }],
    ]);
    await c.delete();
  });

  it("returns errors as results instead of throwing", async () => {
    const c = await provider().createComputer({ externalUserId: "u2" });
    expect(await c.act({ action: "zoom", region: [0, 0, 10, 10] })).toEqual({ action: "zoom", ok: false, error: expect.stringMatching(/does not support zoom/) });
    expect(await c.act({ action: "left_click" })).toMatchObject({ ok: false, error: expect.stringMatching(/needs a coordinate/) });
    expect(await c.act({ action: "key", text: "bogus" })).toEqual({ action: "key", ok: false, error: "key: SERVER_ERROR: Invalid input" });
    expect(await c.act({ action: "hold_key", text: "a", duration: 60 })).toMatchObject({ ok: false });
    expect(await c.act({ action: "fly" as never })).toMatchObject({ ok: false, error: expect.stringMatching(/does not support the "fly"/) });

    const batch = await c.actBatch([
      { action: "left_click", coordinate: [1, 2], noScreenshot: true },
      { action: "zoom" },
      { action: "type", text: "never" },
    ]);
    expect(batch.map((r) => r.ok)).toEqual([true, false]);
    await c.delete();
  });

  it("has no shell or files", async () => {
    const c = await provider().createComputer({ externalUserId: "u3" });
    await expect(c.exec("dir")).rejects.toThrow(/no shell or file tools/);
    await expect(c.readFile("C:/x.txt")).rejects.toThrow(/no shell or file tools/);
    await expect(c.writeFile("C:/x.txt", "hi")).rejects.toThrow(/no shell or file tools/);
    await c.delete();
  });

  it("gives a watch link from get_session_info and refuses control", async () => {
    const c = await provider().createComputer({ externalUserId: "u4" });
    expect(await c.viewer!("watch")).toEqual({ url: "https://appstream2.us-east-1.aws.amazon.com/authenticate?parameters=abc", expiresAt: null });
    await expect(c.viewer!("control")).rejects.toThrow(/no takeover/);
    expect("sleep" in c).toBe(false);
    await c.delete();
  });

  it("reconnects by id, reopens a session the server forgot, and deletes with expire-on-delete", async () => {
    const p = provider();
    const c = await p.createComputer({ externalUserId: "u5" });
    const again = await p.connectComputer(c.nativeId);
    expect(again.nativeId).toBe(c.nativeId);
    expect((await again.act({ action: "screenshot" })).ok).toBe(true);

    // The server drops the session: the next call opens a new one for the same user.
    sessions.delete(c.nativeId.split("~")[0]);
    const r = await again.act({ action: "left_click", coordinate: [1, 1], noScreenshot: true });
    expect(r.ok).toBe(true);
    expect(again.nativeId).not.toBe(c.nativeId);
    expect(again.nativeId.endsWith("~u5")).toBe(true);

    reqs = [];
    await again.delete();
    const del = reqs.find((x) => x.method === "DELETE")!;
    expect(del.headers["mcp-session-id"]).toBe(again.nativeId.split("~")[0]);
    expect(del.headers["x-amzn-agentaccess-expire-streaming-session-on-delete"]).toBe("true");
    expect(String(del.headers.authorization)).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(sessions.has(again.nativeId.split("~")[0])).toBe(false);
    await again.delete(); // idempotent
  });

  it("fails clearly when not configured or the desktop never comes up", async () => {
    await expect(new WorkspacesAgentProvider({ region: "us-east-1" }).createComputer({})).rejects.toThrow(/WORKSPACES_AGENT_STACK/);
    await expect(provider().createComputer({ os: "linux" })).rejects.toThrow(/runs windows/);
    toolListsUntilReady = 1000;
    await expect(provider({ readyTimeoutMs: 30 }).createComputer({ externalUserId: "u6" })).rejects.toThrow(/did not become ready: tools\/list: dcv session not ready/);
    expect(reqs.at(-1)!.method).toBe("DELETE");
  });
});
