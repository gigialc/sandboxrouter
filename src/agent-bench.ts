import { BILLED_VS_LIST } from "./billing.js";
import { DEFAULT_MEMORY_GB, DEFAULT_VCPU, fittingSpec, fixedSize } from "./catalog.js";
import { median } from "./bench-store.js";
import { Router } from "./router.js";
import { busyMs, maxCoreMs, taskUsd } from "./task.js";
import { LIMITED_ERROR } from "./bench.js";
import type { ProviderId, SandboxSpec } from "./types.js";

/**
 * A real agent in every sandbox: the same model gets the same task, with one tool that runs a shell command in
 * the sandbox. The model runs here (its key never enters the sandbox), so the sandbox waits while it thinks,
 * as with any real agent. Afterwards the result is checked independently inside the sandbox.
 *
 * Measures, per provider: how often the task was done right, wall time, time spent waiting on the model, the
 * sandbox CPU used, turns, and what the sandbox was billed (start, minimum, fee, active CPU where it applies).
 */
export const AGENT_TASK_VERSION = "gemini-primes-v1";

export const AGENT_TASK = [
  "You are working in a fresh Linux sandbox through a tool that runs shell commands.",
  "Write /tmp/work/primes.py: it computes the first 5000 prime numbers without using the network, writes them to",
  "/tmp/work/primes.txt one per line, and prints their sum. Run it and fix it until it works.",
  "When it works, reply with DONE and the sum.",
].join(" ");

/** Checked after the agent stops: the file has 5000 primes ending in 48611, and the script prints the right sum. */
const VERIFY = `test "$(wc -l < /tmp/work/primes.txt)" -eq 5000 && test "$(tail -n 1 /tmp/work/primes.txt)" = 48611 && python3 /tmp/work/primes.py | grep -q 114455259 && echo VERIFIED`;

const STAT = `grep '^cpu' /proc/stat 2> /dev/null | tr '\\n' ';'`;

export interface AgentRow {
  provider: ProviderId;
  /** Sessions that started (the ones refused for an account limit are counted in `limited` instead). */
  runs: number;
  /** Sessions the provider refused to start for a limit or quota on the benchmarking account. */
  limited?: number;
  /** Runs where the task checked out. */
  ok: number;
  medianWallMs?: number;
  /** Time spent waiting on the model: the sandbox sat idle. */
  medianModelMs?: number;
  medianCpuMs?: number;
  medianTurns?: number;
  /** What the sandbox was billed for one run, median. */
  medianUsd?: number;
  medianTokens?: number;
}

type Part = { text?: string; functionCall?: { name: string; args: { command?: string } }; functionResponse?: unknown };
type Content = { role: "user" | "model"; parts: Part[] };

async function gemini(model: string, apiKey: string, contents: Content[]) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents,
      tools: [
        {
          functionDeclarations: [
            {
              name: "run_shell",
              description: "Run a shell command in the sandbox and get its exit code, stdout and stderr.",
              parameters: { type: "OBJECT", properties: { command: { type: "STRING" } }, required: ["command"] },
            },
          ],
        },
      ],
      generationConfig: { temperature: 0 },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const j = (await res.json()) as {
    candidates?: { content?: Content }[];
    usageMetadata?: { totalTokenCount?: number };
    error?: { message?: string };
  };
  if (!res.ok || j.error) throw new Error(`gemini ${res.status}: ${j.error?.message?.slice(0, 160) ?? "no answer"}`);
  return { content: j.candidates?.[0]?.content ?? { role: "model" as const, parts: [] }, tokens: j.usageMetadata?.totalTokenCount ?? 0 };
}

/** One agent session on one provider. */
async function session(router: Router, id: ProviderId, model: string, apiKey: string, maxTurns: number) {
  const spec: SandboxSpec = { vcpu: DEFAULT_VCPU, memoryGb: DEFAULT_MEMORY_GB, timeoutMinutes: 15, cpuUtilization: 0.1 };
  const sized = { ...spec, ...fixedSize(id, spec) };
  const t0 = performance.now();
  const box = await router.create(sized, { provider: id, fallback: false, deadlineSeconds: 180 });
  const createMs = performance.now() - t0;
  try {
    await box.exec("mkdir -p /tmp/work");
    const a = (await box.exec(STAT)).stdout;
    const s0 = performance.now();
    const contents: Content[] = [{ role: "user", parts: [{ text: AGENT_TASK }] }];
    let modelMs = 0;
    let tokens = 0;
    let turns = 0;
    for (; turns < maxTurns; turns++) {
      const m0 = performance.now();
      const { content, tokens: t } = await gemini(model, apiKey, contents);
      modelMs += performance.now() - m0;
      tokens += t;
      contents.push({ role: "model", parts: content.parts ?? [] });
      const calls = (content.parts ?? []).filter((p) => p.functionCall);
      if (!calls.length) break;
      const responses: Part[] = [];
      for (const c of calls) {
        const r = await box.exec(String(c.functionCall!.args?.command ?? ""), { timeoutSeconds: 60 }).catch((err) => ({
          exitCode: -1,
          stdout: "",
          stderr: (err as Error).message,
        }));
        responses.push({
          functionResponse: {
            name: "run_shell",
            response: { exitCode: r.exitCode, stdout: r.stdout.slice(-3000), stderr: r.stderr.slice(-2000) },
          },
        });
      }
      contents.push({ role: "user", parts: responses });
    }
    const sessionMs = performance.now() - s0;
    const b = (await box.exec(STAT)).stdout;
    const verified = (await box.exec(VERIFY, { timeoutSeconds: 120 })).stdout.includes("VERIFIED");
    const cpu = busyMs(a, b);
    const plausible = cpu !== undefined && cpu <= sized.vcpu! * sessionMs * 1.1;
    return { verified, createMs, sessionMs, modelMs, turns: turns + 1, tokens, cpuMs: plausible ? cpu : undefined, coreMs: plausible ? maxCoreMs(a, b) : undefined, spec: sized };
  } finally {
    await box.kill().catch(() => {});
  }
}

export async function agentBench(opts: {
  router?: Router;
  providers: ProviderId[];
  runs: number;
  apiKey: string;
  model: string;
  maxTurns?: number;
  parallel?: number;
  onProgress?: (msg: string) => void;
}): Promise<AgentRow[]> {
  const router = opts.router ?? new Router();
  const log = opts.onProgress ?? (() => {});
  const rows: AgentRow[] = [];
  const one = async (id: ProviderId) => {
    const done: Awaited<ReturnType<typeof session>>[] = [];
    let failures = 0;
    let limited = 0;
    for (let i = 0; i < opts.runs; i++) {
      try {
        const s = await session(router, id, opts.model, opts.apiKey, opts.maxTurns ?? 15);
        done.push(s);
        log(`${id} run ${i + 1}/${opts.runs}: ${s.verified ? "done" : "not done"} in ${(s.sessionMs / 1000).toFixed(1)} s, ${s.turns} turns`);
      } catch (err) {
        failures++;
        if (LIMITED_ERROR.test((err as Error).message)) limited++;
        log(`${id} run ${i + 1}/${opts.runs} failed: ${(err as Error).message.slice(0, 160)}`);
      }
    }
    const ok = done.filter((s) => s.verified);
    const size = fittingSpec(id);
    const ratio = BILLED_VS_LIST[id]?.ratio ?? 1;
    const usd = (s: (typeof done)[number]) =>
      taskUsd(id, { ...size, cpuUtilization: 0.1 }, s.createMs, s.sessionMs, s.cpuMs, ratio, false, s.coreMs);
    const m = (xs: number[]) => (xs.length ? median(xs.map(Math.round)) : undefined);
    rows.push({
      provider: id,
      runs: opts.runs - limited,
      ...(limited ? { limited } : {}),
      ok: ok.length,
      medianWallMs: m(done.map((s) => s.sessionMs)),
      medianModelMs: m(done.map((s) => s.modelMs)),
      medianCpuMs: m(done.map((s) => s.cpuMs).filter((n): n is number => n !== undefined)),
      medianTurns: m(done.map((s) => s.turns)),
      ...(done.length ? { medianUsd: Math.round((median(done.map((s) => Math.round(usd(s) * 1e9)))! / 1e9) * 1e9) / 1e9 } : {}),
      medianTokens: m(done.map((s) => s.tokens)),
    });
    if (failures) log(`${id}: ${failures} of ${opts.runs} sessions failed to start or crashed`);
  };
  const queue = [...opts.providers];
  const lanes = Array.from({ length: Math.max(1, Math.min(opts.parallel ?? 1, queue.length)) }, async () => {
    for (let id = queue.shift(); id; id = queue.shift()) await one(id);
  });
  await Promise.all(lanes);
  return rows.sort((a, b) => b.ok - a.ok || (a.medianUsd ?? Infinity) - (b.medianUsd ?? Infinity));
}
