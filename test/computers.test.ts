import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MaritimeProvider } from "../src/providers/maritime.js";
import { Router } from "../src/router.js";
import { createApp } from "../src/server.js";
import { ALL, FakeProvider } from "./fake.js";

/** Stand-in for Maritime's /api/v1/computers, per maritime.sh/docs/computers (camelCase REST). */
let mock: Server;
let base = "";
const calls: { method: string; path: string; query: string; body?: any; raw?: Buffer }[] = [];
const files = new Map<string, Buffer>();
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

beforeAll(async () => {
  mock = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url!, "http://x");
    const body = req.headers["content-type"]?.includes("json") && raw.length ? JSON.parse(raw.toString()) : undefined;
    calls.push({ method: req.method!, path: url.pathname, query: url.search, body, raw });
    const send = (status: number, obj: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.headers.authorization !== "Bearer mk_test") return send(401, { error: "unauthorized", message: "bad key", retryAfterS: null });

    const computer = { id: "cmp_1", os: body?.os ?? "linux", status: "ready", screen: { width: 1280, height: 800, modelWidth: 1200 }, externalUserId: body?.externalUserId ?? null };
    const p = url.pathname;
    if (p === "/api/v1/computers" && req.method === "POST") {
      if (body.os === "windows") return send(403, { error: "os_not_enabled", message: "Windows needs Growth", retryAfterS: null });
      return send(201, computer);
    }
    if (p === "/api/v1/computers/cmp_1" && req.method === "GET") return send(200, computer);
    if (p === "/api/v1/computers/cmp_1" && req.method === "DELETE") {
      res.writeHead(204);
      return res.end();
    }
    if (p === "/api/v1/computers/cmp_1/actions") {
      if (body.actions) return send(200, { results: body.actions.map((a: any, i: number) => ({ action: a.action, ok: true, frameId: i + 1 })) });
      return send(200, { action: body.action, ok: true, frameId: 7, imageB64: PNG.toString("base64"), width: 1200, height: 750 });
    }
    if (p === "/api/v1/computers/cmp_1/screenshot") {
      res.writeHead(200, { "Content-Type": "image/png", "X-Frame-Id": "8" });
      return res.end(PNG);
    }
    if (p === "/api/v1/computers/cmp_1/exec") return send(200, { exitCode: 0, stdout: `ran ${body.command}`, stderr: "" });
    if (p === "/api/v1/computers/cmp_1/files") {
      const path = url.searchParams.get("path")!;
      if (req.method === "PUT") {
        files.set(path, raw);
        return send(200, { ok: true });
      }
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      return res.end(files.get(path));
    }
    if (p === "/api/v1/computers/cmp_1/viewer") return send(200, { url: `https://view/${body.mode}`, expiresAt: "soon", mode: body.mode });
    if (p === "/api/v1/computers/cmp_1/sleep") return send(200, { status: "sleeping" });
    send(404, { error: "not_found", message: p, retryAfterS: null });
  });
  await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(mock.address() as { port: number }).port}`;
});
afterAll(() => mock.close());

const maritime = () => new MaritimeProvider("mk_test", base);
const last = () => calls.at(-1)!;

describe("Maritime computers", () => {
  it("get-or-creates by externalUserId and drives the desktop", async () => {
    const c = await maritime().createComputer({ externalUserId: "u_42", screen: { width: 1024, height: 1024 } });
    expect(calls.find((x) => x.path === "/api/v1/computers")!.body).toEqual({ os: "linux", externalUserId: "u_42", screen: { width: 1024, height: 1024 } });

    const r = await c.act({ action: "left_click", coordinate: [412, 230] });
    expect(last().body).toEqual({ action: "left_click", coordinate: [412, 230] });
    expect(r.frameId).toBe(7);
    expect(Buffer.from(r.imageB64!, "base64").equals(PNG)).toBe(true);

    const batch = await c.actBatch([{ action: "type", text: "hello" }, { action: "key", text: "Return" }]);
    expect(batch.map((b) => b.frameId)).toEqual([1, 2]);

    expect(Buffer.from(await c.screenshot({ format: "jpeg", quality: 70 })).equals(PNG)).toBe(true);
    expect(last().query).toBe("?format=jpeg&quality=70");
  });

  it("runs shell, moves files, mints viewer links, sleeps and deletes", async () => {
    const c = await maritime().connectComputer("cmp_1");
    expect(await c.exec("ls /data", 99)).toEqual({ exitCode: 0, stdout: "ran ls /data", stderr: "" });
    expect(last().body).toEqual({ command: "ls /data", timeoutS: 30 });

    await c.writeFile("/data/a.txt", "hi");
    expect(new TextDecoder().decode(await c.readFile("/data/a.txt"))).toBe("hi");

    expect(await c.viewer("control", { ttlSeconds: 600, reason: "log in" })).toMatchObject({ url: "https://view/control" });
    expect(last().body).toEqual({ mode: "control", ttlS: 600, reason: "log in" });

    await c.sleep();
    expect(last().path).toBe("/api/v1/computers/cmp_1/sleep");
    await c.delete();
    expect(last()).toMatchObject({ method: "DELETE", path: "/api/v1/computers/cmp_1" });
  });

  it("surfaces computers error slugs", async () => {
    await expect(maritime().createComputer({ os: "windows" })).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("os_not_enabled: Windows needs Growth"),
    });
  });
});

describe("computer routing", () => {
  it("routes to a computer provider and reattaches by routed id", async () => {
    const r = new Router({ providers: [maritime(), ...ALL.slice(1).map((id) => new FakeProvider(id))] });
    const c = await r.computer({ os: "android" });
    expect(c.id).toBe("maritime:cmp_1");
    expect((await r.getComputer(c.id)).nativeId).toBe("cmp_1");
    await expect(r.getComputer("e2b:x")).rejects.toThrow(/e2b does not offer computers/);
  });

  it("explains when nobody can provide one", async () => {
    const none = new Router({ providers: ALL.map((id) => new FakeProvider(id)) });
    await expect(none.computer()).rejects.toThrow(/no provider offers a linux computer/);
    const unconfigured = new Router({ providers: [new MaritimeProvider(undefined, base)] });
    await expect(unconfigured.computer()).rejects.toThrow(/no configured provider for a linux computer \(offered by: maritime\)/);
  });

  it("is exposed over HTTP", async () => {
    const app = createApp(new Router({ providers: [maritime()] }), "tok");
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
    const h = { Authorization: "Bearer tok", "Content-Type": "application/json" };
    try {
      const created = await (await fetch(`${url}/v1/computers`, { method: "POST", headers: h, body: JSON.stringify({ externalUserId: "u_1" }) })).json();
      expect(created).toMatchObject({ id: "maritime:cmp_1", nativeId: "cmp_1", provider: "maritime", status: "ready" });
      const id = encodeURIComponent(created.id);
      const act = await (await fetch(`${url}/v1/computers/${id}/actions`, { method: "POST", headers: h, body: JSON.stringify({ action: "screenshot" }) })).json();
      expect(act.frameId).toBe(7);
      const shot = await fetch(`${url}/v1/computers/${id}/screenshot`, { headers: h });
      expect(shot.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await shot.arrayBuffer()).equals(PNG)).toBe(true);
      const link = await (await fetch(`${url}/v1/computers/${id}/viewer`, { method: "POST", headers: h, body: JSON.stringify({ mode: "watch" }) })).json();
      expect(link.url).toBe("https://view/watch");
      expect((await fetch(`${url}/v1/computers/${id}`, { method: "DELETE", headers: h })).status).toBe(200);
    } finally {
      app.close();
    }
  });
});
