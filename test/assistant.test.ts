import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assistant, ASSISTANT_ANALYSE, ASSISTANT_CALL, ASSISTANT_CALLS, ASSISTANT_FIRST, ASSISTANT_VERSION, assistantFixture, assistantSummary, assistantTable,
  type AssistantReport, type AssistantSession,
} from "../src/assistant.js";
import { validateResult } from "../src/results.js";
import type { Router } from "../src/router.js";

const NOW = Date.parse("2026-11-29T00:00:00Z");
const one = (over: Partial<AssistantSession> = {}): AssistantSession => ({
  createMs: 900, firstMs: 300, uploadMs: 1000, analyseMs: 500, downloadMs: 400, callMs: Array.from({ length: ASSISTANT_CALLS }, (_, i) => 200 + i), idleMs: 250, sessionMs: 70_000, ...over,
});
const row = (provider: string, sessions: AssistantSession[], over: Record<string, unknown> = {}) => ({
  provider, size: { vcpu: 2, memoryGb: 4 }, sessions, ...assistantSummary(sessions), failures: 0, sessionUsd: 0.002, hourlyUsd: 0.1, ...over,
});
const report = (over: Record<string, unknown> = {}, rows = [row("modal", [one(), one(), one()])]): AssistantReport =>
  ({
    tool: "sandboxrouter-assistant", version: "0.18.0", task: ASSISTANT_VERSION, date: "2026-11-28T12:00:00Z", label: "home-eu",
    spec: { vcpu: 2, memoryGb: 4 }, runs: 3, calls: ASSISTANT_CALLS, idleSeconds: 60, uploadBytes: 4043648, downloadBytes: 1006589,
    node: "v22.0.0", platform: "darwin-arm64", rows, ...over,
  }) as AssistantReport;

/** A sandbox that behaves: it keeps the uploaded file, runs the analysis and counts the notes. */
function fakeBox(over: { result?: string } = {}) {
  const fixture = assistantFixture();
  let uploaded = "";
  let notes = 0;
  const state = { killed: 0 };
  const box = {
    exec: async (cmd: string) => {
      const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });
      if (cmd === ASSISTANT_FIRST) return ok("42\n");
      if (cmd === ASSISTANT_ANALYSE) return uploaded === fixture.csv ? ok(`${fixture.summary}\n`) : { exitCode: 1, stdout: "", stderr: "no file" };
      if (cmd === ASSISTANT_CALL) return ok(`${++notes}\r\n`);
      return ok("");
    },
    writeFile: async (_path: string, content: string | Uint8Array) => void (uploaded = typeof content === "string" ? content : new TextDecoder().decode(content)),
    readFile: async () => new TextEncoder().encode(over.result ?? "wrong"),
    kill: async () => void state.killed++,
  };
  return { box, state };
}

describe("assistant session", () => {
  it("always builds the same file and the same expected results", () => {
    const a = assistantFixture(1000);
    const b = assistantFixture(1000);
    expect(a).toEqual(b);
    expect(a.csv.split("\n")).toHaveLength(1002);
    expect(a.summary.split("\n").reduce((n, l) => n + Number(l.split(",")[1]), 0)).toBe(1000);
    expect(a.resultSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails a session whose downloaded file is not the one the analysis wrote", async () => {
    const { box, state } = fakeBox();
    const router = { create: async () => box } as unknown as Router;
    const [r] = await assistant({ router, providers: ["modal"], runs: 1, sleep: async () => {} });
    expect(r.sessions).toHaveLength(0);
    expect(r.failures).toBe(1);
    expect(r.firstAnswerMs).toBeUndefined();
    expect(state.killed).toBe(1);
  });

  it("times every step of a session that checks out, and waits out the idle time", async () => {
    // The real fixture's result file is what the analysis would write; rebuild it the way the sandbox does.
    const fixture = assistantFixture();
    const top = fixture.csv.trim().split("\n").slice(1).map((l) => l.split(",")).filter((r) => Number(r[2]) >= 375_000)
      .sort((a, b) => Number(b[2]) - Number(a[2]) || Number(a[0]) - Number(b[0])).map((r) => `${r.join(",")}\n`).join("");
    expect(createHash("sha256").update(top).digest("hex")).toBe(fixture.resultSha256);
    const { box, state } = fakeBox({ result: top });
    const slept: number[] = [];
    const router = { create: async () => box } as unknown as Router;
    const [r] = await assistant({ router, providers: ["modal"], runs: 2, sleep: async (ms) => void slept.push(ms) });
    expect(r.failures).toBe(1); // the second session's notes file starts at 21 in this fake: state from another session must not pass
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0].callMs).toHaveLength(ASSISTANT_CALLS);
    expect(r.size).toEqual({ vcpu: 2, memoryGb: 4 });
    expect(slept).toEqual([60_000]);
    expect(state.killed).toBe(2);
    expect(r.sessionUsd).toBeGreaterThan(0);
  });

  it("summarises sessions: first answer is start plus first call, calls are pooled", () => {
    const s = assistantSummary([one(), one({ createMs: 2000 }), one({ createMs: 100, callMs: Array(ASSISTANT_CALLS).fill(1000) })]);
    expect(s.firstAnswerMs).toBe(1200);
    expect(s.callMs).toBe(215);
    expect(s.callP95Ms).toBe(1000);
    expect(assistantSummary([])).toEqual({});
  });
});

describe("assistant reports", () => {
  it("accepts a complete report", () => {
    expect(validateResult(report(), NOW)).toEqual([]);
  });

  it("refuses numbers that do not match the sessions, missing calls and error text", () => {
    expect(validateResult(report({}, [row("modal", [one(), one(), one()], { firstAnswerMs: 1 })]), NOW).join()).toMatch(/firstAnswerMs does not match/);
    expect(validateResult(report({}, [row("modal", [one(), one(), one({ callMs: [1] })])]), NOW).join()).toMatch(/one time per call/);
    expect(validateResult(report({}, [row("modal", [one(), one()])]), NOW).join()).toMatch(/sessions plus failures/);
    expect(validateResult(report({}, [row("modal", [one(), one(), one()], { error: "401 for key" })]), NOW).join()).toMatch(/errors must not be shared/);
    expect(validateResult(report({ runs: 1 }), NOW).join()).toMatch(/at least 3 sessions/);
  });

  it("lists a provider from its newest report, only when every session passed, fastest first answer first", () => {
    const old = report({ date: "2026-11-20T12:00:00Z" }, [row("modal", [one({ createMs: 5000 }), one({ createMs: 5000 }), one({ createMs: 5000 })])]);
    const table = assistantTable([
      old,
      report({}, [
        row("modal", [one(), one(), one()]),
        row("e2b", [one({ createMs: 200 }), one({ createMs: 200 }), one({ createMs: 200 })]),
        row("daytona", [one(), one()], { failures: 1 }),
      ]),
      report({ task: "assistant-v0" }, [row("vercel", [one(), one(), one()])]),
    ]);
    expect(table.map((r) => r.provider)).toEqual(["e2b", "modal"]);
    expect(table[1].firstAnswerMs).toBe(1200);
    expect(table[0]).toMatchObject({ runs: 3, calls: ASSISTANT_CALLS, idleSeconds: 60, uploadBytes: 4043648 });
  });
});
