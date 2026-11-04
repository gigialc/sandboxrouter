import { afterEach, describe, expect, it } from "vitest";
import { COMPUTER_ENTRIES, createComputer, planComputer, type ComputerProvider, type ProviderComputer } from "../src/computers.js";
import { Router } from "../src/router.js";

/** A computer provider that records calls; `viewer`/`sleep` only when asked for. */
function fakeComputers(id: string, os: ("linux" | "windows" | "android")[], opts: { fail?: string; configured?: boolean; extras?: boolean } = {}) {
  const made: string[] = [];
  const p: ComputerProvider & { made: string[] } = {
    id,
    computerOs: os,
    made,
    configured: () => opts.configured ?? true,
    async createComputer(spec) {
      if (opts.fail) throw new Error(opts.fail);
      const c: ProviderComputer = {
        nativeId: `${id}-${made.length + 1}`,
        info: async () => ({ id: `${id}-1`, os: spec.os ?? "linux", status: "ready" }),
        act: async (a) => ({ action: a.action, ok: true }),
        actBatch: async (as) => as.map((a) => ({ action: a.action, ok: true })),
        screenshot: async () => new Uint8Array([1]),
        exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        readFile: async () => new Uint8Array(),
        writeFile: async () => {},
        delete: async () => {},
        ...(opts.extras ? { viewer: async () => ({ url: "https://view", expiresAt: null }), sleep: async () => {} } : {}),
      };
      made.push(c.nativeId);
      return c;
    },
    async connectComputer(nativeId) {
      return { ...(await this.createComputer({})), nativeId };
    },
  };
  return p;
}

const saved = [...COMPUTER_ENTRIES];
afterEach(() => {
  COMPUTER_ENTRIES.length = 0;
  COMPUTER_ENTRIES.push(...saved);
});

function price(id: string, os: Record<string, number>) {
  COMPUTER_ENTRIES.push({ id, name: id, os, source: "https://example.com", checked: "2026-11-04", takeover: false, size: "1 vCPU · 1 GB", credentials: [], docs: "https://example.com" });
}

describe("computer routing is neutral", () => {
  it("picks the cheapest provider for the requested OS, ties alphabetical", async () => {
    price("zeta", { linux: 0.05, windows: 0.3 });
    price("alpha", { linux: 0.05 });
    price("mid", { linux: 0.09, android: 0.1 });
    const ps = [fakeComputers("zeta", ["linux", "windows"]), fakeComputers("mid", ["linux", "android"]), fakeComputers("alpha", ["linux"])];
    expect(planComputer(ps, "linux").map((c) => c.provider)).toEqual(["alpha", "zeta", "mid"]);
    expect(planComputer(ps, "windows").filter((c) => !c.skip).map((c) => c.provider)).toEqual(["zeta"]);
    expect((await createComputer(ps, { os: "android" })).provider).toBe("mid");
  });

  it("falls back, keeps an explicit order, and skips unconfigured providers", async () => {
    price("a", { linux: 0.01 });
    price("b", { linux: 0.02 });
    price("c", { linux: 0.03 });
    const ps = [fakeComputers("a", ["linux"], { fail: "busy" }), fakeComputers("b", ["linux"], { configured: false }), fakeComputers("c", ["linux"])];
    expect((await createComputer(ps, {})).provider).toBe("c");
    expect(planComputer(ps, "linux", ["c", "a"]).map((c) => c.provider)).toEqual(["c", "a"]);
    await expect(createComputer(ps, { os: "windows" })).rejects.toThrow(/no provider offers a windows computer/);
  });

  it("says clearly when a provider has no live view or sleep", async () => {
    price("plain", { linux: 0.01 });
    const r = new Router({ providers: [], computers: [fakeComputers("plain", ["linux"]), fakeComputers("rich", ["linux"], { extras: true })] });
    const plain = await r.computer({}, { provider: "plain" });
    expect(plain.supports).toEqual({ viewer: false, sleep: false });
    await expect(plain.viewer("control")).rejects.toThrow(/no shareable live view/);
    const rich = await r.computer({}, { provider: "rich" });
    expect(rich.supports).toEqual({ viewer: true, sleep: true });
    expect((await rich.viewer("watch")).url).toBe("https://view");
    expect((await r.getComputer(rich.id)).provider).toBe("rich");
  });
});
