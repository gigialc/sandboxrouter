import { describe, expect, it } from "vitest";
import { accessLabel } from "../src/catalog.js";
import { Router } from "../src/router.js";
import { FakeProvider } from "./fake.js";

describe("sign-up access", () => {
  it("labels gated providers and says so when they're skipped for lack of a key", () => {
    expect(accessLabel("instabox")).toBe("sign-up waitlisted");
    expect(accessLabel("koyeb")).toBe("not taking new accounts");
    expect(accessLabel("e2b")).toBeNull();
    const router = new Router({
      providers: [new FakeProvider("koyeb", { configured: false }), new FakeProvider("e2b", { configured: false }), new FakeProvider("instabox")],
      ledger: false,
    });
    const plan = router.plan();
    expect(plan.find((c) => c.provider === "koyeb")?.skip).toBe("not configured; not taking new accounts");
    expect(plan.find((c) => c.provider === "e2b")?.skip).toBe("not configured");
    // Someone who already has a key still gets routed there.
    expect(plan.find((c) => c.provider === "instabox")?.skip).toBeUndefined();
  });
});
