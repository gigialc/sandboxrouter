import { readFileSync, writeFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** A 1080x2400 PNG header (signature + IHDR), enough for the size read. */
const PNG = (() => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(1080, 16);
  b.writeUInt32BE(2400, 20);
  return b.toString("base64");
})();
const IOS_PNG = "aW9zLXBuZw==";

const calls: [string, ...unknown[]][] = [];
const rec =
  (name: string, ret: unknown = undefined) =>
  async (...args: unknown[]) => {
    calls.push([name, ...args]);
    return typeof ret === "function" ? (ret as (...a: unknown[]) => unknown)(...args) : ret;
  };
const sdk = (name: string) => calls.filter((c) => c[0] === name).map((c) => c.slice(1));

const pushed: Record<string, string> = {};
let shellResult = { stdout: "hi\n", stderr: "", exitCode: 0, truncated: false };

function instance(id: string, extra: Record<string, unknown> = {}) {
  return {
    metadata: { id, createdAt: "", organizationId: "org", labels: { externalUserId: "u_42" } },
    spec: { inactivityTimeout: "3m", region: "us-west1" },
    status: {
      state: "ready",
      apiUrl: `https://${id}.limrun.net`,
      adbWebSocketUrl: `wss://${id}.limrun.net/adb`,
      token: "tok",
      signedStreamUrl: `https://console.limrun.com/stream/${id}?token=s`,
      ...extra,
    },
  };
}

let androidInst: any;
let iosInst: any;
let readyOnGet = false;

function api(kind: "android" | "ios") {
  const cur = () => (kind === "android" ? androidInst : iosInst);
  return {
    create: rec(`${kind}.create`, () => cur()),
    get: rec(`${kind}.get`, (id: string) => {
      const i = cur();
      if (!i || i.metadata.id !== id) throw Object.assign(new Error("404 not found"), { status: 404 });
      return readyOnGet ? { ...i, status: { ...i.status, state: "ready" } } : i;
    }),
    delete: rec(`${kind}.delete`),
  };
}

const androidClient = {
  screenshot: rec("a.screenshot", { dataUri: `data:image/png;base64,${PNG}` }),
  tap: rec("a.tap", { x: 0, y: 0 }),
  setText: rec("a.setText", { textLength: 1 }),
  pressKey: rec("a.pressKey", { key: "" }),
  scrollScreen: rec("a.scrollScreen", {}),
  scrollElement: rec("a.scrollElement", {}),
  adbShell: rec("a.adbShell", () => shellResult),
  pushFile: rec("a.pushFile", (local: string, dest: string) => ((pushed[dest] = readFileSync(local, "utf8")), dest)),
  pullFile: rec("a.pullFile", (_remote: string, local: string) => writeFileSync(local, "from-device")),
  getConnectionState: () => "connected",
  disconnect: () => calls.push(["a.disconnect"]),
};

const iosClient = {
  deviceInfo: { udid: "U", screenWidth: 402, screenHeight: 874, model: "iPhone 17 Pro" },
  screenshot: rec("i.screenshot", { base64: IOS_PNG, width: 402, height: 874 }),
  tap: rec("i.tap"),
  typeText: rec("i.typeText"),
  pressKey: rec("i.pressKey"),
  scroll: rec("i.scroll"),
  performActions: rec("i.performActions", { results: [] }),
  pushFile: rec("i.pushFile", (local: string, dest: string) => ((pushed[dest] = readFileSync(local, "utf8")), `/host/${dest}`)),
  pullFile: rec("i.pullFile", Buffer.from("ios-file")),
  getConnectionState: () => "connected",
  disconnect: () => calls.push(["i.disconnect"]),
};

vi.mock("@limrun/api", () => ({
  Limrun: class {
    androidInstances = api("android");
    iosInstances = api("ios");
    constructor(opts: unknown) {
      calls.push(["Limrun", opts]);
    }
  },
  createInstanceClient: rec("a.connect", () => androidClient),
  Ios: { createInstanceClient: rec("i.connect", () => iosClient) },
}));

const { LimrunProvider, limrunKey } = await import("../src/providers/limrun.js");
const p = () => new LimrunProvider("lim_test", { inactivityTimeout: "10m" });

beforeEach(() => {
  calls.length = 0;
  shellResult = { stdout: "hi\n", stderr: "", exitCode: 0, truncated: false };
  androidInst = instance("and_1");
  iosInst = instance("ios_1");
  readyOnGet = false;
});

describe("Limrun computers", () => {
  it("is configured by LIM_API_KEY and offers android and ios", () => {
    expect(new LimrunProvider(undefined).configured()).toBe(false);
    expect(p().configured()).toBe(true);
    expect(p().computerOs).toEqual(["android", "ios"]);
    expect(p().id).toBe("limrun");
  });

  it("creates an Android phone by default, waiting for ready and reusing by user label", async () => {
    const c = await p().createComputer({ externalUserId: "u_42", name: "agent" });
    expect(c.nativeId).toBe("and_1");
    expect(sdk("android.create")).toEqual([
      [
        {
          wait: true,
          reuseIfExists: true,
          metadata: { displayName: "agent", labels: { externalUserId: "u_42" } },
          spec: { inactivityTimeout: "10m", model: "phone" },
        },
      ],
    ]);
    expect(await c.info()).toEqual({
      id: "and_1",
      os: "android",
      status: "ready",
      externalUserId: "u_42",
      screen: { width: 1080, height: 2400 },
    });
    expect(sdk("a.connect")).toEqual([[{ apiUrl: "https://and_1.limrun.net", token: "tok", adbUrl: "wss://and_1.limrun.net/adb", logLevel: "error" }]]);
    await expect(p().createComputer({ os: "linux" })).rejects.toThrow(/no linux computers/);
  });

  it("creates an iPhone simulator and polls until it is ready", { timeout: 10_000 }, async () => {
    iosInst = instance("ios_1", { state: "creating" });
    readyOnGet = true; // create answers "creating"; the poll's next get sees it ready
    const c = await p().createComputer({ os: "ios" });
    expect(c.nativeId).toBe("ios_1");
    expect(sdk("ios.create")[0][0]).toMatchObject({ wait: true, reuseIfExists: false, spec: { model: "iphone" } });
    expect(sdk("ios.get")).toEqual([["ios_1"]]);
    const info = await c.info();
    expect(info).toMatchObject({ os: "ios", status: "ready", screen: { width: 402, height: 874 } });
  });

  it("connects by id, falling back from Android to iOS", async () => {
    const a = await p().connectComputer("and_1");
    expect((await a.info()).os).toBe("android");
    const i = await p().connectComputer("ios_1");
    expect((await i.info()).os).toBe("ios");
    await expect(p().connectComputer("nope")).rejects.toThrow(/no android or ios instance nope/);
  });

  it("screenshot returns base64 PNG with its size", async () => {
    const c = await p().connectComputer("and_1");
    expect(await c.act({ action: "screenshot" })).toMatchObject({ action: "screenshot", ok: true, imageB64: PNG, mime: "image/png", width: 1080, height: 2400 });
    const i = await p().connectComputer("ios_1");
    expect(await i.act({ action: "screenshot" })).toMatchObject({ ok: true, imageB64: IOS_PNG, mime: "image/png", width: 402, height: 874 });
    expect(sdk("i.screenshot")).toEqual([[{ format: "png" }]]);
    expect(Buffer.from(await c.screenshot()).toString("base64")).toBe(PNG);
  });

  it("taps, double taps and long presses, with a fresh screenshot after each", async () => {
    const c = await p().connectComputer("and_1");
    const r = await c.act({ action: "left_click", coordinate: [100.4, 200.6] });
    expect(r).toMatchObject({ ok: true, imageB64: PNG, frameId: 1 });
    expect(sdk("a.tap")).toEqual([[{ x: 100, y: 201 }]]);
    await c.act({ action: "double_click", coordinate: [5, 6] });
    await c.act({ action: "right_click", coordinate: [7, 8] });
    await c.act({ action: "left_click", coordinate: [1, 2], duration: 1.5 });
    expect(sdk("a.adbShell")).toEqual([
      ["sh", ["-c", "input tap 5 6; input tap 5 6"]],
      ["input", ["swipe", "7", "8", "7", "8", "800"]],
      ["input", ["swipe", "1", "2", "1", "2", "1500"]],
    ]);

    const i = await p().connectComputer("ios_1");
    await i.act({ action: "left_click", coordinate: [10, 20] });
    await i.act({ action: "double_click", coordinate: [10, 20] });
    await i.act({ action: "right_click", coordinate: [3, 4] });
    expect(sdk("i.tap")).toEqual([[10, 20]]);
    expect(sdk("i.performActions")).toEqual([
      [[{ type: "tap", x: 10, y: 20 }, { type: "tap", x: 10, y: 20 }]],
      [[{ type: "touchDown", x: 3, y: 4 }, { type: "wait", durationMs: 800 }, { type: "touchUp", x: 3, y: 4 }]],
    ]);
    expect((await i.act({ action: "left_click" })).error).toMatch(/needs coordinate/);
  });

  it("drags as a swipe and scrolls by steps", async () => {
    const c = await p().connectComputer("and_1");
    await c.act({ action: "left_click_drag", startCoordinate: [500, 1800], coordinate: [500, 600], noScreenshot: true });
    expect(sdk("a.adbShell")).toEqual([["input", ["swipe", "500", "1800", "500", "600", "300"]]]);
    await c.act({ action: "scroll", scrollDirection: "down", scrollAmount: 5 });
    await c.act({ action: "scroll", scrollDirection: "up", coordinate: [300, 400] });
    expect(sdk("a.scrollScreen")).toEqual([["down", 5]]);
    expect(sdk("a.scrollElement")).toEqual([[{ x: 300, y: 400 }, "up", 3]]);

    const i = await p().connectComputer("ios_1");
    await i.act({ action: "left_click_drag", startCoordinate: [0, 100], coordinate: [0, 0] });
    const batch = sdk("i.performActions")[0][0] as any[];
    expect(batch[0]).toEqual({ type: "touchDown", x: 0, y: 100 });
    expect(batch.at(-1)).toEqual({ type: "touchUp", x: 0, y: 0 });
    expect(batch.filter((a) => a.type === "touchMove")).toHaveLength(10);
    await i.act({ action: "scroll", scrollDirection: "down", scrollAmount: 2, coordinate: [50, 60] });
    expect(sdk("i.scroll")).toEqual([["down", 200, { coordinate: [50, 60] }]]);
  });

  it("types text", async () => {
    const c = await p().connectComputer("and_1");
    await c.act({ action: "type", text: "hello" });
    expect(sdk("a.setText")).toEqual([[undefined, "hello"]]);
    const i = await p().connectComputer("ios_1");
    await i.act({ action: "type", text: "hola" });
    expect(sdk("i.typeText")).toEqual([["hola", false, { requireFocus: false }]]);
  });

  it("maps xdotool key names", async () => {
    expect(limrunKey("Return", "android")).toEqual({ key: "ENTER", modifiers: [] });
    expect(limrunKey("BackSpace", "android")).toEqual({ key: "DEL", modifiers: [] });
    expect(limrunKey("Escape", "android")).toEqual({ key: "BACK", modifiers: [] });
    expect(limrunKey("ctrl+a", "android")).toEqual({ key: "a", modifiers: ["ctrl"] });
    expect(limrunKey("4", "android")).toEqual({ key: "KEYCODE_4", modifiers: [] });
    expect(limrunKey("XF86AudioRaiseVolume", "android")).toEqual({ key: "VOLUME_UP", modifiers: [] });
    expect(limrunKey("super+shift+Up", "ios")).toEqual({ key: "up", modifiers: ["command", "shift"] });
    expect(limrunKey("Home", "ios")).toMatchObject({ button: "home" });
    expect(() => limrunKey("Back", "ios")).toThrow(/no iOS equivalent/);

    const c = await p().connectComputer("and_1");
    await c.act({ action: "key", text: "ctrl+a BackSpace", repeat: 2, noScreenshot: true });
    expect(sdk("a.pressKey")).toEqual([
      ["a", ["ctrl"]],
      ["DEL", undefined],
      ["a", ["ctrl"]],
      ["DEL", undefined],
    ]);
    const i = await p().connectComputer("ios_1");
    await i.act({ action: "key", text: "Home" });
    await i.act({ action: "key", text: "Return" });
    expect(sdk("i.performActions")).toEqual([[[{ type: "buttonDown", button: "home" }, { type: "buttonUp", button: "home" }]]]);
    expect(sdk("i.pressKey")).toEqual([["enter", undefined]]);
    expect(await i.act({ action: "key", text: "Back" })).toMatchObject({ ok: false, error: expect.stringMatching(/left edge/) });
  });

  it("returns error results for actions a phone can't do, and never throws", async () => {
    const c = await p().connectComputer("and_1");
    for (const action of ["cursor_position", "zoom", "mouse_move", "middle_click", "hold_key", "left_mouse_down"] as const) {
      const r = await c.act({ action, coordinate: [1, 1], region: [0, 0, 10, 10], text: "a" });
      expect(r.ok, action).toBe(false);
      expect(r.error).toBeTruthy();
    }
    androidClient.tap = rec("a.tap", () => {
      throw new Error("ws closed");
    });
    expect(await c.act({ action: "left_click", coordinate: [1, 1] })).toEqual({ action: "left_click", ok: false, error: "ws closed" });
    androidClient.tap = rec("a.tap", { x: 0, y: 0 });
    const results = await c.actBatch([{ action: "wait", duration: 0 }, { action: "zoom" }, { action: "screenshot" }]);
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(results[0].imageB64).toBeUndefined();
  });

  it("execs through adb shell on Android and refuses on iOS", async () => {
    const c = await p().connectComputer("and_1");
    expect(await c.exec("echo hi | cat", 5)).toEqual({ exitCode: 0, stdout: "hi\n", stderr: "" });
    expect(sdk("a.adbShell")).toEqual([["sh", ["-c", "echo hi | cat"], { timeoutMs: 5000 }]]);
    shellResult = { stdout: "", stderr: "nope", exitCode: 1, truncated: true };
    expect(await c.exec("false")).toMatchObject({ exitCode: 1, stderr: expect.stringMatching(/nope[\s\S]*truncated/) });
    const i = await p().connectComputer("ios_1");
    await expect(i.exec("ls")).rejects.toThrow(/limrun: iOS simulators have no shell/);
  });

  it("pushes and pulls files", async () => {
    const c = await p().connectComputer("and_1");
    await c.writeFile("/sdcard/a.txt", "abc");
    expect(pushed["/sdcard/a.txt"]).toBe("abc");
    expect(Buffer.from(await c.readFile("/sdcard/b.txt")).toString()).toBe("from-device");
    expect(sdk("a.pullFile")[0][0]).toBe("/sdcard/b.txt");

    const i = await p().connectComputer("ios_1");
    await i.writeFile("/config.json", new TextEncoder().encode("{}"));
    expect(pushed["config.json"]).toBe("{}");
    expect(Buffer.from(await i.readFile("config.json")).toString()).toBe("ios-file");
    expect(sdk("i.pullFile")).toEqual([["config.json"]]);
  });

  it("viewer hands out the signed stream URL for control and refuses watch", async () => {
    const c = await p().connectComputer("and_1");
    expect(c.sleep).toBeUndefined();
    expect(await c.viewer!("control")).toEqual({ url: "https://console.limrun.com/stream/and_1?token=s", expiresAt: null });
    await expect(c.viewer!("watch")).rejects.toThrow(/no view-only link/);
    androidInst = instance("and_1", { signedStreamUrl: undefined });
    await expect(c.viewer!("control")).rejects.toThrow(/no stream URL/);
  });

  it("deletes the instance and closes the device connection", async () => {
    const c = await p().connectComputer("and_1");
    await c.act({ action: "screenshot" });
    await c.delete();
    expect(sdk("a.disconnect")).toHaveLength(1);
    expect(sdk("android.delete")).toEqual([["and_1"]]);
    const i = await p().connectComputer("ios_1");
    await i.delete();
    expect(sdk("ios.delete")).toEqual([["ios_1"]]);
  });
});
