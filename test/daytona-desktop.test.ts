import { beforeEach, describe, expect, it, vi } from "vitest";

/** A 1280x800 PNG header (signature + IHDR), enough for the size read. */
const PNG = (() => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(1280, 16);
  b.writeUInt32BE(800, 20);
  return b.toString("base64");
})();

const calls: [string, ...unknown[]][] = [];
const rec =
  (name: string, ret: unknown = undefined) =>
  async (...args: unknown[]) => {
    calls.push([name, ...args]);
    return typeof ret === "function" ? (ret as (...a: unknown[]) => unknown)(...args) : ret;
  };

let createParams: any;
let status = "inactive";

function fakeSandbox(state = "started") {
  return {
    id: "sbx_1",
    state,
    labels: { externalUserId: "u_42" },
    refreshData: rec("refreshData"),
    start: rec("sandbox.start"),
    stop: rec("sandbox.stop"),
    delete: rec("sandbox.delete"),
    setAutoDeleteInterval: rec("setAutoDeleteInterval"),
    getSignedPreviewUrl: rec("getSignedPreviewUrl", (port: number) => ({ url: `https://${port}-tok.proxy.daytona.works`, token: "tok", port })),
    process: { executeCommand: rec("executeCommand", { exitCode: 0, result: "hi\n" }) },
    fs: { downloadFile: rec("downloadFile", Buffer.from("abc")), uploadFile: rec("uploadFile") },
    computerUse: {
      start: rec("cu.start", () => ((status = "active"), { message: "ok" })),
      getStatus: rec("cu.getStatus", () => ({ status })),
      mouse: {
        click: rec("mouse.click", { x: 0, y: 0 }),
        move: rec("mouse.move", { x: 0, y: 0 }),
        drag: rec("mouse.drag", { x: 0, y: 0 }),
        down: rec("mouse.down", {}),
        up: rec("mouse.up", {}),
        scroll: rec("mouse.scroll", true),
        getPosition: rec("mouse.getPosition", { x: 7, y: 9 }),
      },
      keyboard: { type: rec("keyboard.type"), press: rec("keyboard.press"), down: rec("keyboard.down"), up: rec("keyboard.up") },
      screenshot: {
        takeFullScreen: rec("screenshot.takeFullScreen", { screenshot: PNG }),
        takeRegion: rec("screenshot.takeRegion", { screenshot: PNG }),
        takeCompressed: rec("screenshot.takeCompressed", { screenshot: PNG }),
      },
      display: { getInfo: rec("display.getInfo", { displays: [{ width: 1280, height: 800 }] }) },
    },
  };
}

let sandbox = fakeSandbox();

vi.mock("@daytonaio/sdk", () => ({
  Daytona: class {
    async create(params: unknown) {
      createParams = params;
      return sandbox;
    }
    async get(id: string) {
      calls.push(["daytona.get", id]);
      return sandbox;
    }
  },
}));

const { DaytonaProvider, daytonaKeys } = await import("../src/providers/daytona.js");

const p = () => new DaytonaProvider("dtn_test");
const sdk = (name: string) => calls.filter((c) => c[0] === name).map((c) => c.slice(1));

beforeEach(() => {
  calls.length = 0;
  status = "inactive";
  sandbox = fakeSandbox();
});

describe("Daytona computers", () => {
  it("creates a Linux desktop, stores the user id as a label and starts computer use", async () => {
    const c = await p().createComputer({ os: "linux", externalUserId: "u_42", screen: { width: 1280, height: 800 } });
    expect(c.nativeId).toBe("sbx_1");
    expect(createParams).toMatchObject({
      labels: { externalUserId: "u_42" },
      envVars: { VNC_RESOLUTION: "1280x800" },
      autoDeleteInterval: -1,
    });
    expect(sdk("cu.start")).toHaveLength(1);
    expect(p().computerOs).toEqual(["linux"]);
    await expect(p().createComputer({ os: "windows" })).rejects.toThrow(/no windows computers/);
    await expect(p().createComputer({ screen: { width: 100, height: 100 } })).rejects.toThrow(/outside/);
  });

  it("screenshot returns base64 PNG with its size", async () => {
    const c = await p().connectComputer("sbx_1");
    const r = await c.act({ action: "screenshot" });
    expect(r).toMatchObject({ action: "screenshot", ok: true, imageB64: PNG, mime: "image/png", width: 1280, height: 800 });
    expect(sdk("screenshot.takeFullScreen")).toHaveLength(1);
  });

  it("maps clicks, type, key, scroll and drag to the SDK, with a fresh screenshot after each", async () => {
    const c = await p().connectComputer("sbx_1");
    const r = await c.act({ action: "left_click", coordinate: [412, 230], modifier: "shift" });
    expect(r.ok).toBe(true);
    expect(r.imageB64).toBe(PNG);
    expect(sdk("mouse.click")).toEqual([[412, 230, "left", false, 1, ["shift"]]]);

    await c.act({ action: "triple_click", coordinate: [5, 6] });
    await c.act({ action: "right_click" });
    expect(sdk("mouse.click").slice(1)).toEqual([
      [5, 6, "left", false, 3, undefined],
      [7, 9, "right", false, 1, undefined],
    ]);

    await c.act({ action: "type", text: "hello world" });
    expect(sdk("keyboard.type")).toEqual([["hello world"]]);

    await c.act({ action: "key", text: "ctrl+Return" });
    await c.act({ action: "key", text: "BackSpace", repeat: 2 });
    await c.act({ action: "key", text: "ctrl+a Delete" });
    expect(sdk("keyboard.press")).toEqual([
      ["enter", ["ctrl"]],
      ["backspace", []],
      ["backspace", []],
      ["a", ["ctrl"]],
      ["delete", []],
    ]);

    await c.act({ action: "scroll", coordinate: [100, 200], scrollDirection: "down", scrollAmount: 5 });
    expect(sdk("mouse.scroll")).toEqual([[100, 200, "down", 5, undefined]]);

    await c.act({ action: "left_click_drag", startCoordinate: [1, 2], coordinate: [30, 40] });
    expect(sdk("mouse.drag")).toEqual([[1, 2, 30, 40, "left", undefined]]);

    // One screenshot per action above (9 actions).
    expect(sdk("screenshot.takeFullScreen")).toHaveLength(9);
  });

  it("skips the screenshot with noScreenshot, zooms by region crop and reports the cursor", async () => {
    const c = await p().connectComputer("sbx_1");
    const r = await c.act({ action: "mouse_move", coordinate: [3, 4], noScreenshot: true });
    expect(r).toEqual({ action: "mouse_move", ok: true });
    expect(sdk("screenshot.takeFullScreen")).toHaveLength(0);

    const z = await c.act({ action: "zoom", region: [10, 20, 110, 70] });
    expect(sdk("screenshot.takeRegion")).toEqual([[{ x: 10, y: 20, width: 100, height: 50 }]]);
    expect(z.imageB64).toBe(PNG);

    const pos = await c.act({ action: "cursor_position", noScreenshot: true });
    expect(pos).toMatchObject({ ok: true, coordinate: [7, 9] });
  });

  it("holds keys for the duration and releases them", async () => {
    const c = await p().connectComputer("sbx_1");
    await c.act({ action: "hold_key", text: "shift", duration: 0, noScreenshot: true });
    expect(sdk("keyboard.down")).toEqual([["shift"]]);
    expect(sdk("keyboard.up")).toEqual([["shift"]]);
  });

  it("returns an error result instead of throwing", async () => {
    const c = await p().connectComputer("sbx_1");
    const bad = await c.act({ action: "teleport" as any });
    expect(bad).toMatchObject({ ok: false, error: expect.stringContaining("does not support") });
    expect(await c.act({ action: "scroll", coordinate: [1, 1] })).toMatchObject({ ok: false, error: expect.stringContaining("scrollDirection") });
    expect(await c.act({ action: "zoom" })).toMatchObject({ ok: false });
    expect(await c.act({ action: "wait", duration: 1000 })).toMatchObject({ ok: false });

    sandbox.computerUse.keyboard.press = async () => {
      throw new Error("unsupported key: hyper");
    };
    expect(await c.act({ action: "key", text: "Hyper_L" })).toEqual({ action: "key", ok: false, error: "unsupported key: hyper" });
  });

  it("batches stop at the first error and screenshot only at the end", async () => {
    const c = await p().connectComputer("sbx_1");
    const ok = await c.actBatch([
      { action: "left_click", coordinate: [1, 1] },
      { action: "type", text: "x" },
    ]);
    expect(ok.map((r) => [r.ok, !!r.imageB64])).toEqual([
      [true, false],
      [true, true],
    ]);
    const stopped = await c.actBatch([{ action: "mouse_move" }, { action: "type", text: "y" }]);
    expect(stopped).toHaveLength(1);
    expect(stopped[0].ok).toBe(false);
  });

  it("wakes a stopped computer on connect and restarts the desktop", async () => {
    sandbox = fakeSandbox("stopped");
    await p().connectComputer("sbx_1");
    expect(sdk("sandbox.start")).toHaveLength(1);
    expect(sdk("cu.start")).toHaveLength(1);
  });

  it("exec, files, viewer, info, sleep and delete", async () => {
    const c = await p().connectComputer("sbx_1");
    expect(await c.exec("echo hi", 10)).toEqual({ exitCode: 0, stdout: "hi\n", stderr: "" });
    expect(sdk("executeCommand")).toEqual([["echo hi", undefined, undefined, 10]]);
    expect(new TextDecoder().decode(await c.readFile("/a"))).toBe("abc");
    await c.writeFile("/b", "xyz");
    expect(sdk("uploadFile")[0][1]).toBe("/b");

    const v = await c.viewer!("watch", { ttlSeconds: 600 });
    expect(sdk("getSignedPreviewUrl")).toEqual([[6080, 600]]);
    const u = new URL(v.url);
    expect(u.pathname).toBe("/vnc.html");
    expect(u.searchParams.get("view_only")).toBe("true");
    expect(v.expiresAt).not.toBeNull();
    expect(new URL((await c.viewer!("control")).url).searchParams.get("view_only")).toBe("false");

    expect(await c.info()).toEqual({ id: "sbx_1", os: "linux", status: "ready", externalUserId: "u_42", screen: { width: 1280, height: 800 } });

    await c.sleep!();
    expect(sdk("sandbox.stop")).toHaveLength(1);
    await c.delete();
    expect(sdk("sandbox.delete")).toHaveLength(1);
  });

  it("maps xdotool key names", () => {
    expect(daytonaKeys("ctrl+shift+Page_Down")).toEqual(["ctrl", "shift", "pagedown"]);
    expect(daytonaKeys("super+KP_5")).toEqual(["cmd", "num5"]);
    expect(daytonaKeys("Escape")).toEqual(["escape"]);
  });
});
