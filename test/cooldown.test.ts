import { describe, expect, it } from "vitest";
import { Router } from "../src/router.js";
import { ALL, FakeProvider } from "./fake.js";

const order = (r: Router) => r.plan().map((c) => c.provider);

describe("cooldown", () => {
  it("sends a provider that hit a limit to the back of the line, and a success brings it back", async () => {
    const maritime = new FakeProvider("maritime", { fail: "429 Too Many Requests: concurrency limit", failStatus: 429 });
    const r = new Router({ failing: [], providers: ALL.map((id) => (id === "maritime" ? maritime : new FakeProvider(id))), ledger: false, published: false });
    expect(order(r)[0]).toBe("maritime");
    const box = await r.create();
    expect(box.provider).toBe("daytona");
    // Now last, with the reason, and the next create doesn't try it first.
    expect(order(r).at(-1)).toBe("maritime");
    expect(r.plan().at(-1)!.cooling).toMatch(/hit a limit; back in line in \d+s/);
    expect(r.troubled()).toEqual([expect.objectContaining({ provider: "maritime", reason: "hit a limit" })]);
    expect((await r.create()).provider).toBe("daytona");
    // Still used when named, and a success clears it.
    maritime.opts.fail = undefined;
    await r.create({}, { provider: "maritime", fallback: false });
    expect(order(r)[0]).toBe("maritime");
    expect(r.troubled()).toEqual([]);
  });

  it("cools a provider after repeated failures, not after one", async () => {
    const maritime = new FakeProvider("maritime", { fail: "500 internal error", failStatus: 500 });
    const r = new Router({ failing: [], providers: ALL.map((id) => (id === "maritime" ? maritime : new FakeProvider(id))), ledger: false, published: false });
    await r.create();
    await r.create();
    expect(order(r)[0]).toBe("maritime");
    await r.create();
    expect(order(r).at(-1)).toBe("maritime");
    expect(r.troubled()[0].reason).toMatch(/3 failed creates/);
  });

  it("can be turned off", async () => {
    const maritime = new FakeProvider("maritime", { fail: "429 rate limited", failStatus: 429 });
    const r = new Router({ failing: [], providers: ALL.map((id) => (id === "maritime" ? maritime : new FakeProvider(id))), ledger: false, published: false, cooldown: false });
    await r.create();
    expect(order(r)[0]).toBe("maritime");
  });
});
