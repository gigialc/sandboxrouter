import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OrgoProvider } from "../src/providers/orgo.js";
import { ProviderError } from "../src/types.js";

/**
 * Stand-in for Orgo's REST API (www.orgo.ai/api), with the request and response shapes from
 * docs.orgo.ai/api-reference/openapi.json (spec 2.0.0): snake_case JSON, Bearer sk_live_ key.
 */
let mock: Server;
let base = "";
const calls: { method: string; path: string; query: URLSearchParams; body?: any; form?: Record<string, unknown> }[] = [];
const disk = new Map<string, Buffer>();
const exported = new Map<string, Buffer>();
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);
let status = "running";
/** GET polls left before a resuming/starting computer reports running. */
let transitionPolls = 0;

const COMPUTER = (os = "linux", resolution = "1280x720x24") => ({
  id: "a3bb189e-8bf9-3888-9912-ace4e6543002",
  name: "agent-1",
  workspace_id: "ws_1",
  project_id: "ws_1",
  os,
  ram: 8,
  cpu: 2,
  status,
  resolution,
  instance_id: "a3881618",
  connection_url: "https://www.orgo.ai/desktops/a3881618",
  vnc_password: "a06db12a8683df96",
});
const CID = COMPUTER().id;
const action = (name: string, details: unknown) => ({ success: true, action: name, details, error: null, error_type: null });

beforeAll(async () => {
  mock = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url!, "http://x");
    const ct = req.headers["content-type"] ?? "";
    const body = ct.includes("json") && raw.length ? JSON.parse(raw.toString()) : undefined;
    let form: Record<string, unknown> | undefined;
    if (ct.startsWith("multipart/form-data")) {
      const fd = await new Request("http://x", { method: "POST", headers: { "content-type": ct }, body: raw }).formData();
      form = {};
      for (const [k, v] of fd.entries()) form[k] = typeof v === "string" ? v : { name: (v as File).name, bytes: Buffer.from(await (v as File).arrayBuffer()) };
    }
    calls.push({ method: req.method!, path: url.pathname, query: url.searchParams, body, form });
    const send = (code: number, obj: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const p = url.pathname;

    // Signed download URL from /files/export: no Orgo auth on it.
    if (p.startsWith("/signed/")) {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      return res.end(exported.get(p.slice("/signed/".length)));
    }
    if (req.headers.authorization !== "Bearer sk_live_test") return send(401, { error: "Invalid API key" });

    const c = `/api/computers/${CID}`;
    if (p === "/api/workspaces" && req.method === "GET") {
      return send(200, {
        workspaces: [
          { id: "ws_ro", name: "shared", role: "viewer", permissions: { canView: true, canWrite: false, canManageAccess: false }, desktops: [] },
          { id: "ws_1", name: "production", role: "owner", permissions: { canView: true, canWrite: true, canManageAccess: true }, desktops: [] },
        ],
      });
    }
    if (p === "/api/computers" && req.method === "POST") {
      if (body.os === "windows") return send(403, { error: "Windows needs a Scale plan or a Windows licence", code: "WINDOWS_REQUIRES_SCALE" });
      return send(201, { ...COMPUTER(body.os, body.resolution), name: body.name, workspace_id: body.workspace_id });
    }
    if (p === c && req.method === "GET") {
      // A resume or start takes a few polls before the computer reports running.
      if (transitionPolls > 0 && --transitionPolls === 0) status = "running";
      return send(200, { ...COMPUTER(), workspace_id: undefined });
    }
    if (p === `${c}/resume`) {
      status = "resuming";
      transitionPolls = 2;
      return send(202, { success: true, status: "resuming" });
    }
    if (p === c && req.method === "DELETE") return send(200, { success: true });
    if (p === `${c}/screenshot`) {
      if (url.searchParams.get("response_format") === "binary") {
        res.writeHead(200, { "Content-Type": "image/png" });
        return res.end(PNG);
      }
      return send(200, { success: true, image: PNG.toString("base64"), mime_type: "image/png", width: 1280, height: 720, metadata: {} });
    }
    if (p === `${c}/click`) return send(200, action("click", body));
    if (p === `${c}/mouse-move`) return send(200, action("mouse_move", body));
    if (p === `${c}/drag`) return send(200, action("drag", body));
    if (p === `${c}/type` && body.text === "boom") return send(503, { error: "The computer could not be reached" });
    if (p === `${c}/type`) return send(200, action("type", { text_length: Buffer.byteLength(body.text) }));
    if (p === `${c}/key`) return send(200, action("key_press", body));
    if (p === `${c}/scroll`) return send(200, action("scroll", { direction: body.direction, amount: body.amount }));
    if (p === `${c}/wait`) return send(200, action("wait", body));
    if (p === `${c}/bash`) {
      const ok = !body.command.includes("false");
      return send(200, { success: true, action: "bash", command: body.command, output: ok ? `ran ${body.command}\n` : "nope", exit_code: ok ? 0 : 1, error: null, error_type: null });
    }
    if (p === `${c}/vnc-password`) return send(200, { password: "0a017c59/5fa7", desktop_api_token: "0a017c59/5fa7" });
    if (p === `${c}/stop`) {
      status = "frozen";
      return send(200, { success: true });
    }
    if (p === `${c}/start`) {
      status = "starting";
      transitionPolls = 2;
      return send(202, { success: true, status: "starting" });
    }
    if (p === "/api/files/upload") {
      const f = form!.file as { name: string; bytes: Buffer };
      disk.set(`${form!.destPath}/${f.name}`.replace("//", "/"), f.bytes);
      return send(200, { ok: true, placedIn: form!.destPath });
    }
    if (p === "/api/files/export") {
      const bytes = disk.get(body.path);
      if (!bytes) return send(404, { error: "No such file on the computer" });
      exported.set("f1", bytes);
      return send(200, { success: true, file: { id: "f1", desktop_id: body.desktopId, filename: "x", source: "export" }, url: `${base}/signed/f1` });
    }
    if (p === "/api/files/delete" && req.method === "DELETE") {
      exported.delete(url.searchParams.get("id")!);
      return send(200, { success: true });
    }
    send(404, { error: `no route ${req.method} ${p}` });
  });
  await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(mock.address() as { port: number }).port}`;
});
afterAll(() => mock.close());
beforeEach(() => {
  calls.length = 0;
  status = "running";
  transitionPolls = 0;
});

const orgo = (workspace?: string) => new OrgoProvider("sk_live_test", `${base}/api`, workspace);
const last = () => calls.at(-1)!;
const find = (path: string) => calls.filter((x) => x.path === `/api/computers/${CID}${path}`);

describe("Orgo computers", () => {
  it("is configured by ORGO_API_KEY and offers Linux and Windows", () => {
    expect(orgo().configured()).toBe(true);
    expect(new OrgoProvider("", base).configured()).toBe(false);
    expect(orgo().computerOs).toEqual(["linux", "windows"]);
  });

  it("creates a Medium in the first writable workspace, honouring screen and naming it from externalUserId", async () => {
    const c = await orgo().createComputer({ externalUserId: "user 42", screen: { width: 1024, height: 768 } });
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/workspaces" });
    const create = calls.find((x) => x.path === "/api/computers")!.body;
    expect(create).toMatchObject({ workspace_id: "ws_1", os: "linux", cpu: 2, ram: 8, disk_size_gb: 40, resolution: "1024x768x24" });
    expect(create.name).toMatch(/^user-42-[0-9a-f]{8}$/);
    expect(c.nativeId).toBe(CID);
    expect(await c.info()).toEqual({ id: CID, os: "linux", status: "ready", externalUserId: "user 42", screen: { width: 1280, height: 720 } });
  });

  it("uses ORGO_WORKSPACE_ID and spec.name as given", async () => {
    await orgo("ws_9").createComputer({ name: "agent-1" });
    expect(calls.map((x) => x.path)).toEqual(["/api/computers"]);
    expect(last().body).toMatchObject({ workspace_id: "ws_9", name: "agent-1" });
  });

  it("raises the HTTP status and Orgo error code", async () => {
    const err = await orgo("ws_1").createComputer({ os: "windows" }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.status).toBe(403);
    expect(err.message).toContain("WINDOWS_REQUIRES_SCALE");
    const bad = await new OrgoProvider("sk_live_wrong", `${base}/api`, "ws_1").createComputer({}).catch((e) => e);
    expect(bad.status).toBe(401);
    await expect(orgo("ws_1").createComputer({ os: "android" })).rejects.toThrow(/no android computers/);
  });

  it("maps canonical actions and returns a fresh PNG after each", async () => {
    const c = await orgo().connectComputer(CID);

    const shot = await c.act({ action: "screenshot" });
    expect(shot).toMatchObject({ action: "screenshot", ok: true, mime: "image/png", width: 1280, height: 720 });
    expect(Buffer.from(shot.imageB64!, "base64").equals(PNG)).toBe(true);
    expect(last().query.get("response_format")).toBe("base64");
    expect(last().query.get("format")).toBe("png");

    const click = await c.act({ action: "left_click", coordinate: [412.4, 230] });
    expect(find("/click")[0].body).toEqual({ x: 412, y: 230, button: "left" });
    expect(click).toMatchObject({ ok: true, frameId: 2, width: 1280 });

    await c.act({ action: "right_click", coordinate: [1, 2], modifier: "ctrl+shift" });
    expect(find("/click")[1].body).toEqual({ x: 1, y: 2, button: "right", modifiers: ["ctrl", "shift"] });
    await c.act({ action: "double_click", coordinate: [5, 6] });
    expect(find("/click")[2].body).toEqual({ x: 5, y: 6, button: "left", double: true });
    await c.act({ action: "triple_click", coordinate: [5, 6] });
    expect(find("/click")[3].body).toEqual({ x: 5, y: 6, button: "left", repeat: 3 });

    await c.act({ action: "type", text: "Hello, world!" });
    expect(find("/type")[0].body).toEqual({ text: "Hello, world!" });

    await c.act({ action: "key", text: "ctrl+a Delete", repeat: 2 });
    expect(find("/key").map((x) => x.body.key)).toEqual(["ctrl+a", "Delete", "ctrl+a", "Delete"]);

    await c.act({ action: "scroll", coordinate: [640, 400], scrollDirection: "down", scrollAmount: 5 });
    expect(find("/scroll")[0].body).toEqual({ x: 640, y: 400, direction: "down", amount: 5 });

    await c.act({ action: "left_click_drag", startCoordinate: [100, 100], coordinate: [300, 200] });
    expect(find("/drag")[0].body).toEqual({ start_x: 100, start_y: 100, end_x: 300, end_y: 200 });

    await c.act({ action: "mouse_move", coordinate: [640, 360], noScreenshot: true });
    expect(find("/mouse-move")[0].body).toEqual({ x: 640, y: 360 });
    expect(last().path).toBe(`/api/computers/${CID}/mouse-move`);

    await c.act({ action: "wait", duration: 0.5, noScreenshot: true });
    expect(find("/wait")[0].body).toEqual({ seconds: 0.5 });
  });

  it("returns an error result, never throws, for what Orgo can't do", async () => {
    const c = await orgo().connectComputer(CID);
    calls.length = 0;
    for (const a of [
      { action: "zoom", region: [0, 0, 10, 10] },
      { action: "left_mouse_down" },
      { action: "cursor_position" },
      { action: "hold_key", text: "shift" },
      { action: "scroll", coordinate: [1, 1], scrollDirection: "left" },
      { action: "left_click" },
      { action: "left_click_drag", coordinate: [3, 3] },
      { action: "double_click", coordinate: [1, 1], modifier: "shift" },
      { action: "left_click", coordinate: [1, 1], modifier: "hyper" },
    ] as const) {
      const r = await c.act(a as any);
      expect(r.ok, a.action).toBe(false);
      expect(r.error).toBeTruthy();
    }
    expect(calls).toEqual([]);

    // An HTTP failure inside an action is an error result too.
    const r = await c.act({ action: "type", text: "boom" });
    expect(r).toMatchObject({ action: "type", ok: false });
    expect(r.error).toContain("503");
  });

  it("batches in order, screenshots only at the end, stops at the first error", async () => {
    const c = await orgo().connectComputer(CID);
    calls.length = 0;
    const out = await c.actBatch([
      { action: "type", text: "hi" },
      { action: "key", text: "Return" },
    ]);
    expect(calls.map((x) => x.path.split("/").at(-1))).toEqual(["type", "key", "screenshot"]);
    expect(out[0].imageB64).toBeUndefined();
    expect(out[1].imageB64).toBe(PNG.toString("base64"));

    const stop = await c.actBatch([{ action: "zoom", region: [0, 0, 1, 1] }, { action: "type", text: "never" }]);
    expect(stop).toHaveLength(1);
    expect(stop[0].ok).toBe(false);
  });

  it("screenshots as binary PNG or JPEG", async () => {
    const c = await orgo().connectComputer(CID);
    expect(Buffer.from(await c.screenshot()).equals(PNG)).toBe(true);
    expect(Object.fromEntries(last().query)).toEqual({ response_format: "binary", format: "png" });
    await c.screenshot({ format: "jpeg", quality: 60 });
    expect(Object.fromEntries(last().query)).toEqual({ response_format: "binary", format: "jpeg", quality: "60" });
  });

  it("runs bash with exit codes", async () => {
    const c = await orgo().connectComputer(CID);
    expect(await c.exec("echo hi", 500)).toEqual({ exitCode: 0, stdout: "ran echo hi\n", stderr: "" });
    expect(last().body).toEqual({ command: "echo hi", timeout: 300 });
    expect((await c.exec("false")).exitCode).toBe(1);
  });

  it("writes through /files/upload and reads through /files/export, then cleans up the copy", async () => {
    const c = await orgo().connectComputer(CID);
    await c.writeFile("/root/Desktop/notes.txt", "hello orgo");
    const up = calls.find((x) => x.path === "/api/files/upload")!;
    expect(up.form).toMatchObject({ desktopId: CID, destPath: "/root/Desktop", workspaceId: "ws_1" });
    expect((up.form!.file as any).name).toBe("notes.txt");

    const bytes = await c.readFile("/root/Desktop/notes.txt");
    expect(Buffer.from(bytes).toString()).toBe("hello orgo");
    expect(calls.find((x) => x.path === "/api/files/export")!.body).toEqual({ desktopId: CID, path: "/root/Desktop/notes.txt" });
    expect(last()).toMatchObject({ method: "DELETE", path: "/api/files/delete" });
    expect(last().query.get("id")).toBe("f1");

    await expect(c.readFile("/nope")).rejects.toMatchObject({ status: 404 });
    await expect(c.writeFile("relative.txt", "x")).rejects.toThrow(/absolute/);
    await expect(c.writeFile("/big", new Uint8Array(10 * 1024 * 1024 + 1))).rejects.toThrow(/10 MB/);
  });

  it("gives a VNC websockify URL for control and refuses watch", async () => {
    const c = await orgo().connectComputer(CID);
    const v = await c.viewer!("control");
    expect(v.expiresAt).toBeNull();
    const u = new URL(v.url);
    expect(u.protocol).toBe("ws:");
    expect(u.pathname).toBe(`/desktops/${CID}/ws/websockify`);
    expect(u.searchParams.get("token")).toBe("0a017c59/5fa7");
    await expect(c.viewer!("watch")).rejects.toThrow(/view-only/);
    expect(new OrgoProvider("k").wsOrigin()).toBe("wss://www.orgo.ai");
  });

  it("connect resumes a suspended computer and waits until it is running", async () => {
    status = "suspended";
    const c = await orgo().connectComputer(CID);
    expect(calls.some((x) => x.method === "POST" && x.path === `/api/computers/${CID}/resume`)).toBe(true);
    // Resume answers 202 while the computer is still coming back; connect must poll until running.
    expect(calls.filter((x) => x.method === "GET" && x.path === `/api/computers/${CID}`).length).toBeGreaterThanOrEqual(3);
    expect((await c.info()).status).toBe("ready");
  }, 15_000);

  it("sleeps by stopping, connect starts it again, delete removes it", async () => {
    const c = await orgo().connectComputer(CID);
    await c.sleep!();
    expect(last()).toMatchObject({ method: "POST", path: `/api/computers/${CID}/stop` });
    expect((await c.info()).status).toBe("sleeping");

    await orgo().connectComputer(CID);
    expect(calls.some((x) => x.path === `/api/computers/${CID}/start`)).toBe(true);
    expect((await c.info()).status).toBe("ready");

    await c.delete();
    expect(last()).toMatchObject({ method: "DELETE", path: `/api/computers/${CID}` });
  });
});
