import { describe, expect, it } from "vitest";
import { PROBLEMS_MARK, note } from "../scripts/live-check-email.js";
import type { CheckReport } from "../src/check.js";

const pass = (provider: string, firstTry?: string) =>
  ({ provider, ok: true, results: [{ step: "create", status: "pass", ms: 1 }], ...(firstTry ? { firstTry } : {}) }) as CheckReport & { firstTry?: string };
const fail = (provider: string, detail: string) =>
  ({ provider, ok: false, results: [{ step: "create", status: "fail", ms: 1, detail }] }) as unknown as CheckReport;
const unpaid = (provider: string) =>
  ({
    provider,
    ok: false,
    inconclusive: "the account running the check can't pay (402)",
    results: [{ step: "create", status: "skip", ms: 1, detail: `the account can't pay (402), so this run says nothing about ${provider}: ${provider}: 402: Your balance is empty.` }],
  }) as unknown as CheckReport;
const day = new Date("2026-11-13T15:00:00Z");

describe("the nightly check's email", () => {
  it("says nothing when everything passed and the last note wasn't an alarm", () => {
    expect(note([pass("e2b"), pass("maritime")], "https://run", "", day)).toBe("");
  });

  it("lists what broke, what's out of credit and what only failed once, in plain words", () => {
    const text = note([fail("daytona", "all providers failed: daytona: Sandbox was\nmodified"), unpaid("openscale"), pass("e2b", "create: timed out"), pass("maritime")], "https://run", "", day);
    expect(text).toBe(
      [
        "**Nightly check, 13 Nov: 2 of 4 providers need a look.**",
        "",
        "**Broken** (failed twice in a row):",
        "- daytona: create: Sandbox was modified",
        "",
        "**Out of credit** (the account couldn't pay, so the check didn't run):",
        "- openscale: Your balance is empty.",
        "",
        "**Passed on the second try** (probably a one-off):",
        "- e2b: first try create: timed out",
        "",
        "**Fine:** maritime",
        "",
        "Details: https://run",
        "",
        PROBLEMS_MARK,
        "",
      ].join("\n"),
    );
  });

  it("sends an all-clear once after an alarm, then goes quiet", () => {
    const allClear = note([pass("e2b"), pass("daytona")], "https://run", `old alarm\n${PROBLEMS_MARK}\n`, day);
    expect(allClear).toBe("**Nightly check, 13 Nov: all 2 providers pass again.**\n\nDetails: https://run\n");
    expect(note([pass("e2b"), pass("daytona")], "https://run", allClear, day)).toBe("");
  });
});
