import { describe, expect, it } from "vitest";
import { hourlyCost } from "../src/catalog.js";
import { Router, parseId } from "../src/router.js";
import { RouterError } from "../src/types.js";
import { ALL, FakeProvider } from "./fake.js";

const fakes = (over: Partial<Record<string, ConstructorParameters<typeof FakeProvider>[1]>> = {}) =>
  ALL.map((id) => new FakeProvider(id, over[id]));

describe("routing", () => {
  it("defaults to Maritime first", async () => {
    const r = new Router({ providers: fakes() });
    expect(r.plan().map((c) => c.provider)).toEqual(ALL);
    const sbx = await r.create();
    expect(sbx.provider).toBe("maritime");
    expect(sbx.id).toBe("maritime:maritime-1");
  });

  it("skips providers without credentials", async () => {
    const r = new Router({ providers: fakes({ maritime: { configured: false } }) });
    expect(r.plan()[0]).toMatchObject({ provider: "maritime", skip: "not configured" });
    expect((await r.create()).provider).toBe("e2b");
  });

  it("falls back down the list and records every attempt", async () => {
    const r = new Router({ providers: fakes({ maritime: { fail: "429 concurrency_limit" }, e2b: { fail: "503" } }) });
    const sbx = await r.create();
    expect(sbx.provider).toBe("daytona");
    expect(sbx.attempts.map((a) => [a.provider, a.ok])).toEqual([
      ["maritime", false],
      ["e2b", false],
      ["daytona", true],
    ]);
    expect(sbx.attempts[0].error).toContain("429");
  });

  it("does not fall back when fallback is false", async () => {
    const r = new Router({ providers: fakes({ maritime: { fail: "boom" } }) });
    await expect(r.create({}, { fallback: false })).rejects.toThrow(/all providers failed: maritime: boom/);
  });

  it("throws RouterError with attempts when everything fails", async () => {
    const r = new Router({ providers: ALL.map((id) => new FakeProvider(id, { fail: `${id} down` })) });
    const err = await r.create().catch((e) => e);
    expect(err).toBeInstanceOf(RouterError);
    expect(err.attempts).toHaveLength(5);
  });

  it("cheapest sorts by estimated hourly price", () => {
    const r = new Router({ providers: fakes() });
    const plan = r.plan({ vcpu: 4, memoryGb: 8 }, { strategy: "cheapest" });
    const prices = plan.map((c) => c.estimatedHourlyUsd);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    expect(plan[0].provider).toBe("maritime");
  });

  it("routes GPU work only to GPU-capable adapters", async () => {
    const r = new Router({ providers: fakes() });
    const plan = r.plan({ gpu: "A10G" });
    expect(plan.filter((c) => !c.skip).map((c) => c.provider)).toEqual(["modal"]);
    expect((await r.create({ gpu: "A10G" })).provider).toBe("modal");
  });

  it("honors required capabilities and size limits", () => {
    const r = new Router({ providers: fakes() });
    expect(r.plan({}, { require: ["custom-image"] }).find((c) => c.provider === "vercel")?.skip).toBe("no custom-image support");
    const big = r.plan({ vcpu: 32, memoryGb: 128 });
    expect(big.find((c) => c.provider === "maritime")?.skip).toMatch(/max 16 vCPU/);
    expect(big.find((c) => c.provider === "modal")?.skip).toBeUndefined();
  });

  it("uses an explicit provider list in the given order", async () => {
    const r = new Router({ providers: fakes({ vercel: { fail: "nope" } }) });
    const sbx = await r.create({}, { provider: ["vercel", "e2b"] });
    expect(sbx.provider).toBe("e2b");
  });

  it("explains why nothing can run", async () => {
    const r = new Router({ providers: ALL.map((id) => new FakeProvider(id, { configured: false })) });
    await expect(r.create()).rejects.toThrow(/no provider can take this sandbox: maritime \(not configured\)/);
  });

  it("reattaches by routed id", async () => {
    const r = new Router({ providers: fakes() });
    const a = await r.create();
    await a.writeFile("/tmp/x", "hi");
    const b = await r.get(a.id);
    expect(await b.readText("/tmp/x")).toBe("hi");
  });
});

describe("ids and prices", () => {
  it("parses provider:id and keeps colons in the native id", () => {
    expect(parseId("modal:sb-1:2")).toEqual({ provider: "modal", nativeId: "sb-1:2" });
    expect(() => parseId("nope")).toThrow();
    expect(() => parseId("aws:i-1")).toThrow(/unknown provider/);
  });

  it("prices 2 vCPU / 4 GB at published rates", () => {
    expect(hourlyCost("maritime")).toBeCloseTo(0.022, 4);
    expect(hourlyCost("e2b")).toBeCloseTo(0.1656, 4);
    expect(hourlyCost("daytona")).toBeCloseTo(0.1656, 4);
    expect(hourlyCost("modal")).toBeCloseTo(0.238, 2);
    expect(hourlyCost("vercel")).toBeCloseTo(0.3408, 4);
  });
});
