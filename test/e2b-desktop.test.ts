import { beforeEach, describe, expect, it, vi } from "vitest";

/** A PNG header with IHDR width 1024, height 768. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 4, 0, 0, 0, 3, 0, 8, 2, 0, 0, 0,
]);

function fakeDesktop() {
  const calls: unknown[][] = [];
  const rec =
    (name: string, ret?: (...a: any[]) => unknown) =>
    vi.fn(async (...args: any[]) => {
      calls.push([name, ...args]);
      return ret?.(...args);
    });
  return {
    calls,
    sandboxId: "sbx_desk",
    screenshot: rec("screenshot", () => PNG),
    moveMouse: rec("moveMouse"),
    leftClick: rec("leftClick"),
    rightClick: rec("rightClick"),
    middleClick: rec("middleClick"),
    doubleClick: rec("doubleClick"),
    mousePress: rec("mousePress"),
    mouseRelease: rec("mouseRelease"),
    scroll: rec("scroll"),
    write: rec("write"),
    press: rec("press"),
    drag: rec("drag"),
    getCursorPosition: rec("getCursorPosition", () => ({ x: 5, y: 6 })),
    getScreenSize: rec("getScreenSize", () => ({ width: 1024, height: 768 })),
    getInfo: rec("getInfo", () => ({ state: "running", metadata: { externalUserId: "u_1" } })),
    pause: rec("pause", () => true),
    kill: rec("kill", () => true),
    commands: {
      run: rec("run", (cmd: string) => {
        if (cmd === "false") throw Object.assign(new Error("exit 1"), { name: "CommandExitError", exitCode: 1, stdout: "", stderr: "nope" });
        return { exitCode: 0, stdout: `ran ${cmd}`, stderr: "" };
      }),
    },
    files: {
      read: rec("files.read", () => PNG),
      write: rec("files.write"),
      remove: rec("files.remove"),
    },
    stream: {
      start: rec("stream.start"),
      stop: rec("stream.stop"),
      getAuthKey: vi.fn(() => "pw123"),
      getUrl: vi.fn((o: any) => `https://6080-sbx_desk.e2b.app/vnc.html?view_only=${!!o.viewOnly}&password=${o.authKey}`),
    },
  };
}

let desk: ReturnType<typeof fakeDesktop>;
const create = vi.fn(async (_opts?: unknown) => desk);
const connect = vi.fn(async (_id: string, _opts?: unknown) => desk);

vi.mock("@e2b/desktop", () => ({ Sandbox: { create: (o: unknown) => create(o), connect: (id: string, o: unknown) => connect(id, o) } }));

const { E2BProvider } = await import("../src/providers/e2b.js");

beforeEach(() => {
  desk = fakeDesktop();
  create.mockClear();
  connect.mockClear();
});

const computer = () => new E2BProvider("e2b_test").createComputer({ externalUserId: "u_1", screen: { width: 1280, height: 800 } });
const names = () => desk.calls.map((c) => c[0]);
const runs = () => desk.calls.filter((c) => c[0] === "run").map((c) => c[1]);

describe("E2B desktop computer", () => {
  it("creates a linux desktop with resolution and externalUserId as metadata", async () => {
    const p = new E2BProvider("e2b_test");
    expect(p.computerOs).toEqual(["linux"]);
    const c = await computer();
    expect(c.nativeId).toBe("sbx_desk");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "e2b_test", resolution: [1280, 800], metadata: { externalUserId: "u_1" } }),
    );
    await expect(p.createComputer({ os: "windows" })).rejects.toThrow(/only offers linux/);
    expect(await c.info()).toMatchObject({ id: "sbx_desk", os: "linux", status: "ready", screen: { width: 1024, height: 768 }, externalUserId: "u_1" });
  });

  it("screenshot returns base64 PNG with its size", async () => {
    const c = await computer();
    const r = await c.act({ action: "screenshot" });
    expect(r).toMatchObject({ action: "screenshot", ok: true, mime: "image/png", width: 1024, height: 768, frameId: 1 });
    expect(Buffer.from(r.imageB64!, "base64")).toEqual(Buffer.from(PNG));
  });

  it("left_click moves then clicks, then screenshots", async () => {
    const c = await computer();
    const r = await c.act({ action: "left_click", coordinate: [0, 40] });
    expect(r.ok).toBe(true);
    expect(desk.calls.slice(0, 3)).toEqual([["moveMouse", 0, 40], ["leftClick"], ["screenshot"]]);
    expect(r.imageB64).toBeTruthy();
  });

  it("noScreenshot skips the screenshot", async () => {
    const c = await computer();
    const r = await c.act({ action: "left_click", coordinate: [1, 2], noScreenshot: true });
    expect(r).toEqual({ action: "left_click", ok: true });
    expect(names()).not.toContain("screenshot");
  });

  it("modifier clicks hold the keys around the click", async () => {
    const c = await computer();
    await c.act({ action: "left_click", coordinate: [3, 4], modifier: "shift", noScreenshot: true });
    expect(runs()).toEqual(["xdotool keydown 'shift'", "xdotool keyup 'shift'"]);
  });

  it("type writes text", async () => {
    const c = await computer();
    await c.act({ action: "type", text: "hello 'world'", noScreenshot: true });
    expect(desk.calls[0]).toEqual(["write", "hello 'world'"]);
  });

  it("key sends xdotool names verbatim and maps friendly names", async () => {
    const c = await computer();
    await c.act({ action: "key", text: "Return", noScreenshot: true });
    await c.act({ action: "key", text: "ctrl+s", noScreenshot: true });
    await c.act({ action: "key", text: "Enter", repeat: 2, noScreenshot: true });
    expect(runs()).toEqual(["xdotool key -- 'Return'", "xdotool key -- 'ctrl+s'", "xdotool key --repeat 2 -- 'Return'"]);
  });

  it("scroll maps up/down to the SDK and left/right to xdotool buttons 6/7", async () => {
    const c = await computer();
    await c.act({ action: "scroll", coordinate: [10, 20], scrollDirection: "up", scrollAmount: 5, noScreenshot: true });
    expect(desk.calls.slice(0, 2)).toEqual([["moveMouse", 10, 20], ["scroll", "up", 5]]);
    await c.act({ action: "scroll", scrollDirection: "right", scrollAmount: 2, noScreenshot: true });
    expect(runs()).toEqual(["xdotool click --repeat 2 7"]);
  });

  it("left_click_drag drags from startCoordinate to coordinate", async () => {
    const c = await computer();
    await c.act({ action: "left_click_drag", startCoordinate: [1, 2], coordinate: [30.4, 40.6], noScreenshot: true });
    expect(desk.calls[0]).toEqual(["drag", [1, 2], [30, 41]]);
  });

  it("mouse down/up, triple click and cursor_position", async () => {
    const c = await computer();
    await c.act({ action: "left_mouse_down", noScreenshot: true });
    await c.act({ action: "left_mouse_up", noScreenshot: true });
    await c.act({ action: "triple_click", coordinate: [7, 8], noScreenshot: true });
    expect(names().slice(0, 4)).toEqual(["mousePress", "mouseRelease", "moveMouse", "run"]);
    expect(runs()).toEqual(["xdotool click --repeat 3 1"]);
    expect(await c.act({ action: "cursor_position", noScreenshot: true })).toMatchObject({ ok: true, x: 5, y: 6 });
  });

  it("zoom crops the region with scrot", async () => {
    const c = await computer();
    const r = await c.act({ action: "zoom", region: [10, 20, 110, 70] });
    expect(r).toMatchObject({ ok: true, width: 1024, height: 768 });
    expect(runs()[0]).toMatch(/^scrot -a 10,20,100,50 \/tmp\/sbr-.*\.png$/);
    expect(names()).not.toContain("screenshot");
  });

  it("returns error results instead of throwing", async () => {
    const c = await computer();
    expect(await c.act({ action: "teleport" as any })).toMatchObject({ ok: false, error: expect.stringContaining("does not support") });
    expect(await c.act({ action: "mouse_move" })).toMatchObject({ ok: false, error: "mouse_move needs a coordinate" });
    expect(await c.act({ action: "zoom", region: [50, 50, 10, 10] })).toMatchObject({ ok: false, error: expect.stringContaining("bad zoom region") });
    desk.leftClick.mockRejectedValueOnce(new Error("xdotool died"));
    expect(await c.act({ action: "left_click", coordinate: [1, 1] })).toMatchObject({ ok: false, error: "xdotool died" });
  });

  it("actBatch stops at the first failure", async () => {
    const c = await computer();
    const rs = await c.actBatch([
      { action: "mouse_move", coordinate: [1, 1], noScreenshot: true },
      { action: "key", noScreenshot: true },
      { action: "type", text: "never", noScreenshot: true },
    ]);
    expect(rs.map((r) => r.ok)).toEqual([true, false]);
    expect(names()).not.toContain("write");
  });

  it("exec, files, viewer, sleep, delete", async () => {
    const c = await computer();
    expect(await c.exec("echo hi")).toEqual({ exitCode: 0, stdout: "ran echo hi", stderr: "" });
    expect(await c.exec("false")).toEqual({ exitCode: 1, stdout: "", stderr: "nope" });
    await c.writeFile("/tmp/a", "x");
    expect(await c.readFile("/tmp/a")).toBe(PNG);

    const watch = await c.viewer!("watch");
    const control = await c.viewer!("control");
    expect(watch).toEqual({ url: expect.stringContaining("view_only=true&password=pw123"), expiresAt: null });
    expect(control.url).toContain("view_only=false");
    expect(desk.stream.start).toHaveBeenCalledTimes(1);
    expect(desk.stream.start).toHaveBeenCalledWith({ requireAuth: true });

    await c.sleep!();
    await c.delete();
    expect(names()).toContain("pause");
    expect(names()).toContain("kill");
  });

  it("connectComputer reattaches by sandbox id", async () => {
    const c = await new E2BProvider("e2b_test").connectComputer("sbx_desk");
    expect(c.nativeId).toBe("sbx_desk");
    expect(connect).toHaveBeenCalledWith("sbx_desk", expect.objectContaining({ apiKey: "e2b_test" }));
  });
});
