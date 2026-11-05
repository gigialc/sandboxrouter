import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gc, isGone, listOpen } from "../src/gc.js";
import { Ledger, defaultLedgerFile } from "../src/ledger.js";
import { Router } from "../src/router.js";
import { ProviderError } from "../src/types.js";
import { FakeProvider } from "./fake.js";

const tmpLedger = () => join(mkdtempSync(join(tmpdir(), "sbr-ledger-")), "sandboxes.jsonl");

describe("sandbox ledger", () => {
  it("records each create and drops it on kill, also when killed through router.get()", async () => {
    const file = tmpLedger();
    const router = new Router({ providers: [new FakeProvider("boat")], ledger: file });
    const a = await router.create({ timeoutMinutes: 5 }, { provider: "boat" });
    const b = await router.create({}, { provider: "boat" });
    expect(router.ledger!.list().map((e) => e.id)).toEqual([a.id, b.id]);
    const e = router.ledger!.list()[0];
    expect(e.provider).toBe("boat");
    expect(Date.parse(e.expiresAt) - Date.parse(e.createdAt)).toBe(5 * 60_000);
    expect(router.ledger!.list()[1].usdHour).toBeGreaterThan(0);

    await a.kill();
    await (await router.get(b.id)).kill();
    expect(router.ledger!.list()).toEqual([]);
    // Another process reading the same file sees the same state.
    expect(new Ledger(file).list()).toEqual([]);
  });

  it("survives a line cut short by a crash, and compact keeps only open entries", () => {
    const file = tmpLedger();
    const l = new Ledger(file);
    l.open({ id: "boat:1", provider: "boat", createdAt: "2026-11-05T10:00:00.000Z", expiresAt: "2026-11-05T10:30:00.000Z", usdHour: 0.018 });
    l.open({ id: "boat:2", provider: "boat", createdAt: "2026-11-05T10:01:00.000Z", expiresAt: "2026-11-05T10:31:00.000Z", usdHour: 0.018 });
    l.close("boat:1");
    appendFileSync(file, '{"op":"open","id":"boat:3","prov');
    expect(l.list().map((e) => e.id)).toEqual(["boat:2"]);
    l.compact();
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(1);
    expect(l.list().map((e) => e.id)).toEqual(["boat:2"]);
  });

  it("is off with ledger: false or SANDBOXROUTER_LEDGER=off, and never breaks a create when it can't write", async () => {
    expect(new Router({ providers: [new FakeProvider("boat")], ledger: false }).ledger).toBeUndefined();
    const prev = process.env.SANDBOXROUTER_LEDGER;
    process.env.SANDBOXROUTER_LEDGER = "off";
    try {
      expect(defaultLedgerFile()).toBeNull();
      expect(new Router({ providers: [new FakeProvider("boat")] }).ledger).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.SANDBOXROUTER_LEDGER;
      else process.env.SANDBOXROUTER_LEDGER = prev;
    }
    const router = new Router({ providers: [new FakeProvider("boat")], ledger: "/dev/null/nope/sandboxes.jsonl" });
    const sbx = await router.create({}, { provider: "boat" });
    await sbx.kill();
  });
});

describe("gc", () => {
  const setup = async () => {
    const fake = new FakeProvider("boat");
    const router = new Router({ providers: [fake], ledger: tmpLedger() });
    const old = await router.create({ timeoutMinutes: 1 }, { provider: "boat" });
    const fresh = await router.create({ timeoutMinutes: 60 }, { provider: "boat" });
    return { fake, router, old, fresh, later: Date.now() + 2 * 60_000 };
  };

  it("kills only sandboxes past their lifetime by default", async () => {
    const { fake, router, old, fresh, later } = await setup();
    const open = listOpen(router, later);
    expect(open.find((s) => s.id === old.id)).toMatchObject({ expired: true, ageMinutes: 2 });
    expect(open.find((s) => s.id === fresh.id)?.expired).toBe(false);

    expect(await gc(router, { now: later, dryRun: true })).toEqual([{ id: old.id, action: "would kill", detail: "past its lifetime" }]);
    expect(fake.live.get(old.nativeId)).toBeDefined();

    expect(await gc(router, { now: later })).toEqual([{ id: old.id, action: "killed" }]);
    expect((await fake.connect(old.nativeId) as unknown as { killed: boolean }).killed).toBe(true);
    expect(router.ledger!.list().map((e) => e.id)).toEqual([fresh.id]);
  });

  it("--all kills everything; a sandbox that is already gone is dropped, other errors are kept", async () => {
    const { fake, router, old, fresh, later } = await setup();
    const third = await router.create({}, { provider: "boat" });
    fake.live.delete(old.nativeId); // gone on the provider side: connect throws "no sandbox ..."
    fake.connect = async (id) => {
      if (id === third.nativeId) throw new ProviderError("boat", "HTTP 500 upstream", 500);
      const b = fake.live.get(id);
      if (!b) throw new ProviderError("boat", `sandbox ${id} not found`, 404);
      return b;
    };
    const results = await gc(router, { all: true, now: later });
    expect(results).toEqual([
      { id: old.id, action: "gone", detail: expect.stringContaining("not found") },
      { id: fresh.id, action: "killed" },
      { id: third.id, action: "failed", detail: expect.stringContaining("500") },
    ]);
    expect(router.ledger!.list().map((e) => e.id)).toEqual([third.id]);
  });

  it("estimates cost so far, capped at the lifetime", async () => {
    const { router, old, later } = await setup();
    const s = listOpen(router, later + 60 * 60_000).find((x) => x.id === old.id)!;
    expect(s.estimatedUsdSoFar).toBeCloseTo(s.usdHour / 60, 4); // 1-minute lifetime
  });

  it("recognizes provider errors that mean the sandbox no longer exists", () => {
    expect(isGone(new ProviderError("e2b", "HTTP 404", 404))).toBe(true);
    expect(isGone(new Error("Sandbox does not exist"))).toBe(true);
    expect(isGone(new Error("HTTP 401 unauthorized"))).toBe(false);
    expect(isGone(new Error("fetch failed"))).toBe(false);
  });
});
