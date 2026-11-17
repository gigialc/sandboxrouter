import { describe, expect, it } from "vitest";
import { compare } from "../src/compare.js";
import { Router } from "../src/router.js";
import { FakeProvider } from "./fake.js";

describe("compare", () => {
  it("runs the same setup and command on each provider and counts every kind of failure", async () => {
    const router = new Router({
      providers: [new FakeProvider("maritime"), new FakeProvider("daytona"), new FakeProvider("e2b", { fail: "503 down", failStatus: 503 })],
      ledger: false,
      cooldown: false,
    });
    // FakeProvider: "exit N" exits N, anything else exits 0.
    const ok = await compare({ router, providers: ["maritime", "daytona", "e2b"], command: "ls", setup: "ls", runs: 2 });
    expect(ok.find((r) => r.provider === "maritime")).toMatchObject({ runs: 2, ok: 2, startFailed: 0, setupFailed: 0, commandFailed: 0 });
    expect(ok.find((r) => r.provider === "maritime")!.estimatedUsd).toBeGreaterThan(0);
    expect(ok.find((r) => r.provider === "maritime")!.medianSetupMs).toBeGreaterThanOrEqual(0);
    expect(ok.find((r) => r.provider === "e2b")).toMatchObject({ ok: 0, startFailed: 2, error: expect.stringMatching(/503 down/) });
    // Providers that worked come first.
    expect(ok.at(-1)!.provider).toBe("e2b");

    const badSetup = await compare({ router, providers: ["maritime"], command: "ls", setup: "exit 3", runs: 1 });
    expect(badSetup[0]).toMatchObject({ ok: 0, setupFailed: 1, error: expect.stringMatching(/setup exited 3/) });
    const badCommand = await compare({ router, providers: ["maritime"], command: "exit 2", runs: 1 });
    expect(badCommand[0]).toMatchObject({ ok: 0, commandFailed: 1, error: expect.stringMatching(/command exited 2/) });
    expect(badCommand[0].estimatedUsd).toBeUndefined();
  });
});
