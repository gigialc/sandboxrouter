import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COMPUTER_ENTRIES, createComputer, planComputer, type ComputerProvider, type ProviderComputer } from "../src/computers.js";
import { gc, listOpen } from "../src/gc.js";
import { Router } from "../src/router.js";
import { ProviderError } from "../src/types.js";

/** A computer provider that records calls; `viewer`/`sleep` only when asked for. */
function fakeComputers(
  id: string,
  os: ("linux" | "windows" | "android")[],
  opts: { fail?: string; failStatus?: number; configured?: boolean; extras?: boolean; createMs?: number } = {},
) {
  const made: string[] = [];
  const deleted: string[] = [];
  const p: ComputerProvider & { made: string[]; deleted: string[] } = {
    id,
    computerOs: os,
    made,
    deleted,
    configured: () => opts.configured ?? true,
    async createComputer(spec) {
      if (opts.createMs) await new Promise((r) => setTimeout(r, opts.createMs));
      if (opts.fail) throw opts.failStatus ? new ProviderError(id, opts.fail, opts.failStatus) : new Error(opts.fail);
      const c: ProviderComputer = {
        nativeId: `${id}-${made.length + 1}`,
        info: async () => ({ id: `${id}-1`, os: spec.os ?? "linux", status: "ready" }),
        act: async (a) => ({ action: a.action, ok: true }),
        actBatch: async (as) => as.map((a) => ({ action: a.action, ok: true })),
        screenshot: async () => new Uint8Array([1]),
        exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        readFile: async () => new Uint8Array(),
        writeFile: async () => {},
        delete: async () => void deleted.push(c.nativeId),
        ...(opts.extras ? { viewer: async () => ({ url: "https://view", expiresAt: null }), sleep: async () => {} } : {}),
      };
      made.push(c.nativeId);
      return c;
    },
    async connectComputer(nativeId) {
      const c = await this.createComputer({});
      made.pop();
      return { ...c, nativeId, delete: async () => void deleted.push(nativeId) };
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

  it("stops on a setup error, falls back when a provider is down, and records every attempt", async () => {
    price("bad", { linux: 0.01 });
    price("down", { linux: 0.02 });
    price("ok", { linux: 0.03 });
    const bad = fakeComputers("bad", ["linux"], { fail: "invalid key", failStatus: 401 });
    const down = fakeComputers("down", ["linux"], { fail: "busy", failStatus: 503 });
    const ok = fakeComputers("ok", ["linux"]);
    await expect(createComputer([bad, down, ok], {})).rejects.toMatchObject({ code: "setup", attempts: [expect.objectContaining({ provider: "bad", status: 401 })] });
    const pc = await createComputer([bad, down, ok], {}, undefined, { fallback: "any" });
    expect(pc.provider).toBe("ok");
    expect(pc.attempts.map((a) => [a.provider, a.ok])).toEqual([
      ["bad", false],
      ["down", false],
      ["ok", true],
    ]);
    const viaDown = await createComputer([down, ok], {});
    expect(viaDown.provider).toBe("ok");
  });

  it("gives up on a slow provider and deletes the computer it makes late", async () => {
    price("slow", { linux: 0.01 });
    price("fast", { linux: 0.02 });
    const slow = fakeComputers("slow", ["linux"], { createMs: 300 });
    const pc = await createComputer([slow, fakeComputers("fast", ["linux"])], {}, undefined, { createTimeoutSeconds: 0.1 });
    expect(pc.provider).toBe("fast");
    expect(pc.attempts[0]).toMatchObject({ provider: "slow", ok: false, error: "slow: create timed out after 0.1s" });
    await new Promise((r) => setTimeout(r, 400));
    expect(slow.deleted).toEqual(slow.made);
  });

  it("puts computers in the ledger: ls shows them, plain gc leaves them, gc --all deletes them", async () => {
    price("desk", { linux: 0.04 });
    const desk = fakeComputers("desk", ["linux"]);
    const r = new Router({ providers: [], computers: [desk], ledger: join(mkdtempSync(join(tmpdir(), "sbr-pc-")), "ledger.jsonl") });
    const pc = await r.computer({}, { provider: "desk" });
    expect(listOpen(r).map((e) => [e.id, e.kind, e.usdHour, e.expired])).toEqual([[pc.id, "computer", 0.04, false]]);
    expect(await gc(r)).toEqual([]);
    expect(await gc(r, { all: true })).toEqual([{ id: pc.id, action: "killed" }]);
    expect(desk.deleted).toEqual([pc.nativeId]);
    expect(listOpen(r)).toEqual([]);
    // Deleting through the handle closes the entry too.
    const again = await r.computer({}, { provider: "desk" });
    await again.kill();
    expect(listOpen(r)).toEqual([]);
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
