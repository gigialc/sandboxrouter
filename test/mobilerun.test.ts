import { beforeEach, describe, expect, it, vi } from "vitest";

/** A 1080x2400 PNG header (signature + IHDR), enough for the size read. */
const PNG = (() => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(1080, 16);
  b.writeUInt32BE(2400, 20);
  return b;
})();
const PNG_B64 = PNG.toString("base64");

const calls: [string, ...unknown[]][] = [];
const rec =
  (name: string, ret: unknown = undefined) =>
  async (...args: unknown[]) => {
    calls.push([name, ...args]);
    return typeof ret === "function" ? (ret as (...a: unknown[]) => unknown)(...args) : ret;
  };
/** Stainless APIPromise stand-in: only asResponse() is used for binary bodies. */
const binary = (name: string, body: () => Response) => (...args: unknown[]) => {
  calls.push([name, ...args]);
  return { asResponse: async () => body() };
};

let state = "ready";
let listItems: any[] = [];
const device = (over: Record<string, unknown> = {}) => ({
  id: "dev_1",
  name: "",
  platform: "android",
  state,
  stateMessage: "",
  streamUrl: "wss://stream.mobilerun.ai/dev_1",
  streamToken: "stk_123",
  type: "android_cloud_phone",
  ...over,
});

function fakeDevices() {
  return {
    create: rec("devices.create", (p: any) => ((state = "creating"), device({ name: p.name ?? "", state: "creating" }))),
    retrieve: rec("devices.retrieve", () => device()),
    list: rec("devices.list", () => ({ items: listItems, pagination: {} })),
    waitReady: rec("devices.waitReady", (id: string) => ((state = "ready"), device({ id }))),
    resume: rec("devices.resume"),
    stop: rec("devices.stop"),
    terminate: rec("devices.terminate"),
    actions: { tap: rec("tap"), swipe: rec("swipe"), global: rec("global") },
    keyboard: { write: rec("keyboard.write"), key: rec("keyboard.key") },
    screenshots: { capture: binary("screenshots.capture", () => new Response(PNG, { headers: { "content-type": "image/png" } })) },
    files: {
      download: binary("files.download", () => new Response(Buffer.from("abc"), { headers: { "content-type": "application/octet-stream" } })),
      upload: rec("files.upload"),
    },
  };
}

let devices = fakeDevices();
let clientOpts: any;

vi.mock("@mobilerun/sdk", () => ({
  Mobilerun: class {
    constructor(opts: unknown) {
      clientOpts = opts;
    }
    get devices() {
      return devices;
    }
  },
  toFile: async (data: Buffer, name: string) => ({ name, data }),
}));

const { MobilerunProvider, mobilerunKey } = await import("../src/providers/mobilerun.js");

const p = () => new MobilerunProvider("dr_sk_test");
const sdk = (name: string) => calls.filter((c) => c[0] === name).map((c) => c.slice(1));

beforeEach(() => {
  calls.length = 0;
  state = "ready";
  listItems = [];
  devices = fakeDevices();
});

describe("Mobilerun computers", () => {
  it("is Android only and configured by the API key", async () => {
    expect(p().computerOs).toEqual(["android"]);
    expect(p().configured()).toBe(true);
    expect(new MobilerunProvider("").configured()).toBe(false);
    await expect(p().createComputer({ os: "linux" })).rejects.toThrow(/no linux computers/);
  });

  it("provisions a cloud phone and waits until ready", async () => {
    const c = await p().createComputer({ os: "android" });
    expect(c.nativeId).toBe("dev_1");
    expect(clientOpts).toMatchObject({ apiKey: "dr_sk_test" });
    expect(sdk("devices.create")).toEqual([[{ deviceType: "android_cloud_phone", billing: "auto" }]]);
    expect(sdk("devices.waitReady")[0][0]).toBe("dev_1");
  });

  it("returns the same phone for the same user, resuming it if parked", async () => {
    listItems = [device({ id: "dev_9", name: "sandboxrouter:u_42", state: "stopped" })];
    const c = await p().createComputer({ externalUserId: "u_42" });
    expect(c.nativeId).toBe("dev_9");
    expect(sdk("devices.create")).toHaveLength(0);
    expect(sdk("devices.resume")).toEqual([["dev_9"]]);

    listItems = [];
    await p().createComputer({ externalUserId: "u_7" });
    expect(sdk("devices.create")).toEqual([[{ deviceType: "android_cloud_phone", billing: "auto", name: "sandboxrouter:u_7" }]]);
  });

  it("screenshot returns base64 PNG with its size", async () => {
    const c = await p().connectComputer("dev_1");
    const r = await c.act({ action: "screenshot" });
    expect(r).toMatchObject({ action: "screenshot", ok: true, imageB64: PNG_B64, mime: "image/png", width: 1080, height: 2400 });
    expect(Buffer.from(await c.screenshot())).toEqual(PNG);
    await expect(c.screenshot({ format: "jpeg" })).rejects.toThrow(/PNG only/);
  });

  it("left_click taps, with a fresh screenshot after", async () => {
    const c = await p().connectComputer("dev_1");
    const r = await c.act({ action: "left_click", coordinate: [412.4, 230] });
    expect(r).toMatchObject({ ok: true, imageB64: PNG_B64, frameId: 1 });
    expect(sdk("tap")).toEqual([["dev_1", { x: 412, y: 230 }]]);
    expect(sdk("screenshots.capture")).toHaveLength(1);
  });

  it("left_click_drag and scroll swipe", async () => {
    const c = await p().connectComputer("dev_1");
    await c.act({ action: "left_click_drag", startCoordinate: [100, 2000], coordinate: [100, 500] });
    expect(sdk("swipe")[0]).toEqual(["dev_1", { startX: 100, startY: 2000, endX: 100, endY: 500, duration: 600 }]);

    // Scroll down = finger moves up, centred on the coordinate; 3 clicks = 45% of 2400.
    await c.act({ action: "scroll", coordinate: [540, 1200], scrollDirection: "down", scrollAmount: 3 });
    expect(sdk("swipe")[1]).toEqual(["dev_1", { startX: 540, startY: 1740, endX: 540, endY: 660, duration: 400 }]);
    await c.act({ action: "scroll", scrollDirection: "right", scrollAmount: 1, noScreenshot: true });
    expect(sdk("swipe")[2]).toEqual(["dev_1", { startX: 621, startY: 1200, endX: 459, endY: 1200, duration: 400 }]);
  });

  it("scroll learns the screen size from a screenshot when it has none", async () => {
    const c = await p().connectComputer("dev_1");
    await c.act({ action: "scroll", scrollDirection: "up", noScreenshot: true });
    expect(sdk("screenshots.capture")).toHaveLength(1);
    expect(sdk("swipe")[0]).toEqual(["dev_1", { startX: 540, startY: 660, endX: 540, endY: 1740, duration: 400 }]);
  });

  it("type writes through the keyboard, key sends Android key codes", async () => {
    const c = await p().connectComputer("dev_1");
    await c.act({ action: "type", text: "hello world", noScreenshot: true });
    expect(sdk("keyboard.write")).toEqual([["dev_1", { text: "hello world" }]]);

    await c.act({ action: "key", text: "Return", noScreenshot: true });
    await c.act({ action: "key", text: "BackSpace", repeat: 2, noScreenshot: true });
    await c.act({ action: "key", text: "Down Escape", noScreenshot: true });
    expect(sdk("keyboard.key").map((x) => (x[1] as { key: number }).key)).toEqual([66, 67, 67, 20, 4]);
    expect(sdk("screenshots.capture")).toHaveLength(0);
  });

  it("maps xdotool key names", () => {
    expect(mobilerunKey("Return")).toBe(66);
    expect(mobilerunKey("KP_Enter")).toBe(66);
    expect(mobilerunKey("BackSpace")).toBe(67);
    expect(mobilerunKey("Delete")).toBe(112);
    expect(mobilerunKey("Tab")).toBe(61);
    expect(mobilerunKey("Home")).toBe(3);
    expect(mobilerunKey("Back")).toBe(4);
    expect(mobilerunKey("Escape")).toBe(4);
    expect(mobilerunKey("Up")).toBe(19);
    expect(mobilerunKey("Right")).toBe(22);
    expect(mobilerunKey("Page_Down")).toBe(93);
    expect(mobilerunKey("space")).toBe(62);
    expect(mobilerunKey("a")).toBe(29);
    expect(mobilerunKey("Z")).toBe(54);
    expect(mobilerunKey("7")).toBe(14);
    expect(() => mobilerunKey("ctrl+a")).toThrow(/chord/);
    expect(() => mobilerunKey("F5")).toThrow(/no Android key/);
  });

  it("unsupported actions come back as error results, never throws", async () => {
    const c = await p().connectComputer("dev_1");
    for (const action of ["right_click", "middle_click", "double_click", "mouse_move", "cursor_position", "hold_key", "zoom", "teleport"] as const) {
      const r = await c.act({ action: action as any, coordinate: [1, 1], text: "shift", region: [0, 0, 10, 10] });
      expect(r).toMatchObject({ action, ok: false, error: expect.stringContaining("does not support") });
    }
    expect(await c.act({ action: "left_click" })).toMatchObject({ ok: false, error: expect.stringContaining("coordinate") });
    expect(await c.act({ action: "key", text: "ctrl+s" })).toMatchObject({ ok: false, error: expect.stringContaining("chord") });
    expect(await c.act({ action: "wait", duration: 1000 })).toMatchObject({ ok: false });

    devices.actions.tap = async () => {
      throw new Error("422 device busy");
    };
    expect(await c.act({ action: "left_click", coordinate: [1, 1] })).toEqual({ action: "left_click", ok: false, error: "422 device busy" });
    expect(sdk("screenshots.capture")).toHaveLength(0);
  });

  it("batches stop at the first error and screenshot only at the end", async () => {
    const c = await p().connectComputer("dev_1");
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

  it("exec throws a clear error", async () => {
    const c = await p().connectComputer("dev_1");
    await expect(c.exec("ls")).rejects.toThrow(/mobilerun: no shell/);
  });

  it("files map to device paths", async () => {
    const c = await p().connectComputer("dev_1");
    expect(new TextDecoder().decode(await c.readFile("/sdcard/Download/a.txt"))).toBe("abc");
    expect(sdk("files.download")[0].slice(0, 2)).toEqual(["dev_1", { path: "/sdcard/Download/a.txt" }]);
    await c.writeFile("/sdcard/Download/b.txt", "xyz");
    const [id, params] = sdk("files.upload")[0] as [string, { path: string; file: { name: string; data: Buffer } }];
    expect(id).toBe("dev_1");
    expect(params.path).toBe("/sdcard/Download");
    expect(params.file.name).toBe("b.txt");
    expect(params.file.data.toString()).toBe("xyz");
    await expect(c.writeFile("/sdcard/", "x")).rejects.toThrow(/file path/);
  });

  it("viewer returns the stream URL and token", async () => {
    const c = await p().connectComputer("dev_1");
    expect(await c.viewer!("control")).toMatchObject({ url: "wss://stream.mobilerun.ai/dev_1", token: "stk_123", expiresAt: null, viewOnlyEnforced: false });
    devices.retrieve = rec("devices.retrieve", () => device({ streamUrl: "", streamToken: undefined }));
    await expect(c.viewer!()).rejects.toThrow(/no live stream/);
  });

  it("info, sleep, connect resumes a parked phone, delete terminates", async () => {
    const c = await p().connectComputer("dev_1");
    await c.act({ action: "screenshot" });
    devices.retrieve = rec("devices.retrieve", () => device({ name: "sandboxrouter:u_42" }));
    expect(await c.info()).toEqual({ id: "dev_1", os: "android", status: "ready", externalUserId: "u_42", screen: { width: 1080, height: 2400 } });

    await c.sleep!();
    expect(sdk("devices.stop")).toEqual([["dev_1"]]);

    devices.retrieve = rec("devices.retrieve", () => device({ state: "stopped" }));
    expect((await c.info()).status).toBe("sleeping");
    await p().connectComputer("dev_1");
    expect(sdk("devices.resume")).toEqual([["dev_1"]]);
    expect(sdk("devices.waitReady")).toHaveLength(1);

    await c.delete();
    expect(sdk("devices.terminate")).toEqual([["dev_1"]]);
  });

  it("keeps waiting when the server-side waitReady times out, like the SDK's APIConnectionTimeoutError", async () => {
    // The SDK's error classes don't set `name`: only the class identifies them.
    class APIConnectionTimeoutError extends Error {}
    let attempts = 0;
    devices.waitReady = rec("devices.waitReady", () => {
      if (++attempts === 1) throw new APIConnectionTimeoutError("Request timed out.");
      state = "ready";
      return device();
    });
    devices.retrieve = rec("devices.retrieve", () => device({ state: "creating" }));
    const c = await p().createComputer({});
    expect(c.nativeId).toBe("dev_1");
    expect(sdk("devices.waitReady")).toHaveLength(2);
  });

  it("wraps SDK errors as ProviderError", async () => {
    devices.retrieve = async () => {
      throw Object.assign(new Error("404 device not found"), { status: 404 });
    };
    await expect(p().connectComputer("nope")).rejects.toMatchObject({ name: "ProviderError", status: 404, message: "mobilerun: 404 device not found" });
  });
});

