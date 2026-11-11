import { afterEach, describe, expect, it, vi } from "vitest";
import { CATALOG, fittingSpec, hourlyCost, unfit } from "../src/catalog.js";
import { EXEC_GRACE_S, Router, parseId } from "../src/router.js";
import { RouterError } from "../src/types.js";
import { ALL, FakeProvider } from "./fake.js";

const fakes = (over: Partial<Record<string, ConstructorParameters<typeof FakeProvider>[1]>> = {}) =>
  ALL.map((id) => new FakeProvider(id, over[id]));

describe("routing", () => {
  it("with nothing marked verified, goes cheapest first, ties broken alphabetically", async () => {
    const r = new Router({ providers: fakes(), verified: [] });
    // daytona and e2b list the same price, so they sort by name
    expect(r.plan().map((c) => c.provider)).toEqual(["maritime", "daytona", "e2b", "modal", "vercel"]);
    expect(r.plan({}, { strategy: "default" })).toEqual(r.plan({}, { strategy: "cheapest" }));
    const sbx = await r.create();
    expect(sbx.provider).toBe("maritime");
    expect(sbx.id).toBe("maritime:maritime-1");
  });

  it("defaults to verified providers first, then cheapest within each group", () => {
    // modal and vercel are pricier than maritime; mark only them verified and they go first.
    const r = new Router({ providers: fakes(), verified: ["vercel", "modal"] });
    expect(r.plan().map((c) => [c.provider, c.verified])).toEqual([
      ["modal", true],
      ["vercel", true],
      ["maritime", false],
      ["daytona", false],
      ["e2b", false],
    ]);
    expect(r.plan({}, { strategy: "verified" })).toEqual(r.plan());
    // "cheapest" ignores verification.
    expect(r.plan({}, { strategy: "cheapest" }).map((c) => c.provider)).toEqual(["maritime", "daytona", "e2b", "modal", "vercel"]);
    // An explicit list keeps the caller's order.
    expect(r.plan({}, { provider: ["e2b", "modal"] }).map((c) => c.provider)).toEqual(["e2b", "modal"]);
  });

  it("uses the release's verified list by default", async () => {
    const { VERIFIED } = await import("../src/verified.js");
    const r = new Router({ providers: fakes() });
    for (const c of r.plan()) expect(c.verified).toBe(c.provider in VERIFIED);
  });

  it("falls back from a verified provider to an unverified one", async () => {
    const r = new Router({ providers: fakes({ modal: { fail: "busy", failStatus: 503 } }), verified: ["modal"] });
    const sbx = await r.create();
    expect(sbx.attempts.map((a) => a.provider)).toEqual(["modal", "maritime"]);
    await sbx.kill();
  });

  it("re-ranks when the size changes the price order", () => {
    // Vercel fixes memory at 2 GB/vCPU, Morph bills whole MCUs: ordering follows each shape's real price
    const r = new Router({ providers: fakes(), verified: [] });
    for (const spec of [{ vcpu: 1, memoryGb: 2 }, { vcpu: 8, memoryGb: 16 }, { vcpu: 2, memoryGb: 8 }]) {
      const prices = r.plan(spec).map((c) => c.estimatedHourlyUsd);
      expect(prices).toEqual([...prices].sort((a, b) => a - b));
    }
  });

  it("skips providers without credentials", async () => {
    const r = new Router({ providers: fakes({ maritime: { configured: false } }) });
    expect(r.plan()[0]).toMatchObject({ provider: "maritime", skip: "not configured" });
    // daytona and e2b are next among tested providers; their default images are smaller than 2 vCPU /
    // 4 GB, so they only take a create that names no size. vercel is the next tested one.
    expect((await r.create({ vcpu: 2, memoryGb: 4 })).provider).toBe("vercel");
    expect((await r.create()).provider).toBe("daytona");
  });

  it("a create that names no size can use a provider with a fixed default image", async () => {
    const r = new Router({ providers: ALL.filter((id) => id === "e2b").map((id) => new FakeProvider(id)), ledger: false });
    expect((await r.create()).provider).toBe("e2b");
    expect((await r.create({ vcpu: 2 })).provider).toBe("e2b");
    const err = await r.create({ vcpu: 2, memoryGb: 4 }).catch((e) => e);
    expect(err.message).toMatch(/^none of the providers you have keys for can take this sandbox: e2b \(default image is 2 vCPU \/ 0\.5 GB/);
    expect(err.message).toMatch(/leave out vcpu and memoryGb/);
  });

  it("falls back down the list and records every attempt", async () => {
    const r = new Router({ providers: fakes({ maritime: { fail: "429 concurrency_limit" }, vercel: { fail: "503" } }) });
    const sbx = await r.create({ vcpu: 2, memoryGb: 4 });
    expect(sbx.provider).toBe("modal");
    expect(sbx.attempts.map((a) => [a.provider, a.ok])).toEqual([
      ["maritime", false],
      ["vercel", false],
      ["modal", true],
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
    expect(err.attempts.map((a: { provider: string }) => a.provider)).toEqual(["maritime", "daytona", "e2b", "vercel", "modal"]);
    // with a size bigger than their default images, daytona and e2b aren't tried
    const sized = await r.create({ vcpu: 2, memoryGb: 4 }).catch((e) => e);
    expect(sized.attempts.map((a: { provider: string }) => a.provider)).toEqual(["maritime", "vercel", "modal"]);
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
    const sbx = await r.create({}, { provider: ["vercel", "modal"] });
    expect(sbx.provider).toBe("modal");
  });

  it("reports an unknown provider id as a skipped candidate, and create refuses it", async () => {
    const r = new Router({ providers: fakes() });
    const plan = r.plan({}, { provider: ["nope" as never, "modal"] });
    expect(plan.map((c) => [c.provider, c.skip])).toEqual([["nope", "unknown provider"], ["modal", undefined]]);
    const err = await r.create({}, { provider: "nope" as never }).catch((e) => e);
    expect(err).toBeInstanceOf(RouterError);
    expect(err.message).toMatch(/nope \(unknown provider\)/);
  });

  it("explains why nothing can run", async () => {
    const r = new Router({ providers: ALL.map((id) => new FakeProvider(id, { configured: false })) });
    await expect(r.create()).rejects.toThrow(/^no provider keys found: set the API key for at least one provider/);
    // a provider you named gets the variables it needs
    await expect(r.create({}, { provider: "maritime" })).rejects.toThrow(
      /no provider can take this sandbox: maritime \(not configured: set MARITIME_API_KEY\)/,
    );
  });

  it("reattaches by routed id", async () => {
    const r = new Router({ providers: fakes() });
    const a = await r.create();
    await a.writeFile("/tmp/x", "hi");
    const b = await r.get(a.id);
    expect(await b.readText("/tmp/x")).toBe("hi");
  });
});

describe("local providers", () => {
  it("never routes to Docker unless asked by name", async () => {
    const r = new Router({ providers: [...fakes(), new FakeProvider("docker")] });
    expect(r.plan().map((c) => c.provider)).not.toContain("docker");
    expect((await r.create()).provider).not.toBe("docker");
    expect((await r.create({}, { provider: "docker" })).provider).toBe("docker");
  });
});

describe("streaming and pause", () => {
  it("passes chunks through and still returns full output", async () => {
    const r = new Router({ providers: fakes() });
    const sbx = await r.create();
    const out: string[] = [];
    const res = await sbx.exec("ls", { onStdout: (c) => out.push(c) });
    expect(out.join("")).toBe(res.stdout);
  });

  describe("exec deadline", () => {
    afterEach(() => vi.useRealTimers());

    it("rejects with the contract's timeout error when an adapter never answers", async () => {
      vi.useFakeTimers();
      const r = new Router({ providers: fakes({ maritime: { hang: true } }) });
      const sbx = await r.create();
      const pending = sbx.exec("sleep 999", { timeoutSeconds: 2 });
      const rejected = expect(pending).rejects.toMatchObject({ name: "ProviderError", provider: "maritime", message: "maritime: command timed out after 2s" });
      // Nothing happens at the adapter's own deadline: the router steps in EXEC_GRACE_S later.
      await vi.advanceTimersByTimeAsync((2 + EXEC_GRACE_S) * 1000 - 1);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
    });

    it("passes a prompt adapter result through untouched", async () => {
      const r = new Router({ providers: fakes() });
      const sbx = await r.create();
      expect(await sbx.exec("ls", { timeoutSeconds: 1 })).toMatchObject({ exitCode: 0, stdout: "ran: ls\n" });
    });
  });

  it("pauses where supported and explains where not", async () => {
    const r = new Router({ providers: fakes({ maritime: { pause: false } }) });
    const a = await r.create({}, { provider: "maritime" });
    expect(a.canPause).toBe(false);
    await expect(a.pause()).rejects.toThrow(/maritime does not support pause/);
    const b = await r.create({ vcpu: 2, memoryGb: 0.5 }, { provider: "e2b" });
    await b.pause();
    expect(b.canPause).toBe(true);
  });

  it("require pause filters to pause-capable adapters", () => {
    const r = new Router({ providers: fakes() });
    const small = { vcpu: 1, memoryGb: 0.5 };
    expect(r.plan(small, { require: ["pause"] }).filter((c) => !c.skip).map((c) => c.provider)).toEqual(["maritime", "daytona", "e2b"]);
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
    // E2B, Daytona and OpenScale run their default image's size unless given an image
    expect(hourlyCost("e2b")).toBeCloseTo(2 * 0.0504 + 0.5 * 0.0162, 4);
    expect(hourlyCost("e2b", { image: { e2b: "my-template" } })).toBeCloseTo(0.1656, 4);
    expect(hourlyCost("daytona")).toBeCloseTo(0.0504 + 0.0162, 4);
    expect(hourlyCost("daytona", { image: { daytona: "python:3.12" } })).toBeCloseTo(0.1656, 4);
    expect(hourlyCost("modal")).toBeCloseTo(0.238, 2);
    expect(hourlyCost("vercel")).toBeCloseTo(0.3408, 4);
    expect(hourlyCost("morph")).toBeCloseTo(0.1, 4);
    expect(hourlyCost("sprites")).toBeCloseTo(0.1645, 4);
    expect(hourlyCost("blaxel")).toBeCloseTo(0.1656, 4);
    expect(hourlyCost("tensorlake")).toBeCloseTo(0.2, 4);
    expect(hourlyCost("runloop")).toBeCloseTo(0.3168, 4);
    expect(hourlyCost("hopx")).toBeCloseTo(0.1656, 4);
    expect(hourlyCost("northflank")).toBeCloseTo(0.0667, 4);
    expect(hourlyCost("boat")).toBeCloseTo(0.018, 4);
    expect(hourlyCost("exedev")).toBeCloseTo(0.105, 4);
    // 2 vCPU / 4 GB rents Cloudflare's standard-3 (2 vCPU, 8 GiB)
    expect(hourlyCost("cloudflare")).toBeCloseTo(2 * 0.072 + 8 * 0.009, 4);
  });

  it("skips a provider whose default image is smaller than the request, unless an image is given", () => {
    expect(unfit("e2b", { vcpu: 2, memoryGb: 4 })).toBe("default image is 2 vCPU / 0.5 GB; a bigger size needs image.e2b");
    expect(unfit("e2b", { memoryGb: 1 })).toMatch(/default image is 2 vCPU/);
    expect(unfit("e2b", { vcpu: 2, memoryGb: 0.5 })).toBeNull();
    expect(unfit("e2b", { vcpu: 2, memoryGb: 4, image: { e2b: "big-template" } })).toBeNull();
    expect(unfit("openscale", { vcpu: 2, memoryGb: 2 })).toMatch(/default image is 2 vCPU \/ 1 GB/);
    expect(unfit("daytona", { vcpu: 2, memoryGb: 1 })).toMatch(/default image is 1 vCPU \/ 1 GB/);
    // Naming no size means "the default image's size is fine".
    for (const id of ["e2b", "daytona", "openscale"] as const) {
      expect(unfit(id, {})).toBeNull();
      expect(hourlyCost(id, {})).toBe(hourlyCost(id, fittingSpec(id)));
    }
    expect(unfit("daytona", { vcpu: 2, memoryGb: 4, image: { daytona: "python:3.12" } })).toBeNull();
  });

  it("prices fixed-size providers by the size they actually rent", () => {
    expect(hourlyCost("boat", { vcpu: 3, memoryGb: 4 })).toBeCloseTo(0.036, 4); // needs the 4 vCPU size
    expect(hourlyCost("boat", { vcpu: 1, memoryGb: 2 })).toBeCloseTo(0.018, 4); // smallest is 2 / 4
    expect(hourlyCost("exedev", { vcpu: 1, memoryGb: 8 })).toBeCloseTo(4 * 0.0525, 4); // 2 GiB per vCPU
  });

  it("prices non-linear shapes the way each provider bills", () => {
    expect(hourlyCost("morph", { vcpu: 2, memoryGb: 16 })).toBeCloseTo(0.2, 4); // 4 MCU: memory dominates
    expect(hourlyCost("blaxel", { vcpu: 8, memoryGb: 4 })).toBeCloseTo(16 * 0.0414, 4); // memory floor from vCPU
  });

  it("the catalog gives no provider a privileged position", () => {
    const names = CATALOG.map((c) => c.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    // Alibaba's default template (2 vCPU / 2 GB) and Azure's sessions are fixed below the default size.
    // E2B, Daytona and OpenScale default images are smaller too (measured in real sandboxes).
    for (const c of CATALOG)
      if (!["alibaba", "azure", "e2b", "daytona", "openscale"].includes(c.id)) expect(unfit(c.id, { vcpu: 2, memoryGb: 4 })).toBeNull();
    expect(CATALOG.filter((c) => c.local).map((c) => c.id)).toEqual(["docker"]);
    expect(new Set(CATALOG.map((c) => hourlyCost(c.id))).size).toBeGreaterThan(1);
  });
});
