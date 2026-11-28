import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BILLED_VS_LIST } from "./billing.js";
import { benchmarksPublishable, CATALOG, DEFAULT_MEMORY_GB, DEFAULT_VCPU, fixedSize, hourlyCost } from "./catalog.js";
import { median } from "./bench-store.js";
import { percentile } from "./burst.js";
import { sizeOf, type Router } from "./router.js";
import { busyMs, maxCoreMs, taskUsd } from "./task.js";
import type { ProviderId, SandboxSpec } from "./types.js";

/**
 * Assistant session benchmark: what a chat assistant with a code tool asks of a sandbox during one
 * conversation, timed the way the person waiting sees it (from the test machine, network included).
 *
 * One session, in one sandbox:
 *  1. first answer: start the sandbox and get the result of a first Python call;
 *  2. upload: put the person's file (a 4 MB CSV) into the sandbox;
 *  3. analyse: a Python script reads it, prints per-category totals and writes a 1 MB result file;
 *  4. download: read the result file back;
 *  5. tool calls: 20 short Python calls, each of which must see what the calls before it wrote;
 *  6. after idle: nothing for a minute (the person is reading), then one more call.
 *
 * Every step is checked against values computed here, so a session only counts when the sandbox really kept
 * the file, ran the analysis and returned the right bytes.
 */

export const ASSISTANT_VERSION = "assistant-v1";
export const ASSISTANT_CALLS = 20;
export const ASSISTANT_IDLE_SECONDS = 60;

const DIR = "/tmp/sr-assistant";
const ROWS = 200_000;
const TOP_FROM = 375_000;

/** The uploaded file and what the analysis must produce from it. Always the same bytes. */
export function assistantFixture(rows = ROWS) {
  let s = 20261128;
  const next = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) >>> 8);
  const lines: string[] = ["id,category,amount_cents"];
  const count = new Map<string, number>();
  const total = new Map<string, number>();
  const top: [number, string, number][] = [];
  for (let id = 1; id <= rows; id++) {
    const category = `cat-${String(next() % 12).padStart(2, "0")}`;
    const amount = next() % 500_000;
    lines.push(`${id},${category},${amount}`);
    count.set(category, (count.get(category) ?? 0) + 1);
    total.set(category, (total.get(category) ?? 0) + amount);
    if (amount >= TOP_FROM) top.push([id, category, amount]);
  }
  top.sort((a, b) => b[2] - a[2] || a[0] - b[0]);
  const result = top.map((r) => `${r.join(",")}\n`).join("");
  return {
    csv: `${lines.join("\n")}\n`,
    /** What the analysis prints: one line per category, with its row count and total. */
    summary: [...count.keys()].sort().map((c) => `${c},${count.get(c)},${total.get(c)}`).join("\n"),
    resultBytes: Buffer.byteLength(result),
    resultSha256: createHash("sha256").update(result).digest("hex"),
  };
}

export const ASSISTANT_FIRST = `python3 -c 'print(6 * 7)'`;

export const ASSISTANT_ANALYSE = `python3 - <<'SRASSISTANT'
import collections, csv
D = "${DIR}"
rows = list(csv.reader(open(D + "/data.csv")))[1:]
count = collections.Counter()
total = collections.Counter()
for i, c, a in rows:
    count[c] += 1
    total[c] += int(a)
top = sorted((r for r in rows if int(r[2]) >= ${TOP_FROM}), key=lambda r: (-int(r[2]), int(r[0])))
with open(D + "/top.csv", "w", newline="") as f:
    f.write("".join(",".join(r) + "\\n" for r in top))
for c in sorted(count):
    print("%s,%d,%d" % (c, count[c], total[c]))
SRASSISTANT`;

/** One short tool call: add a line to a notes file and print how many lines it has now. */
export const ASSISTANT_CALL = `python3 -c 'p = "${DIR}/notes.txt"; open(p, "a").write("x\\n"); print(len(open(p).read().splitlines()))'`;

/**
 * Providers whose adapter has no file endpoint to use and sends files through shell commands, in chunks.
 * Their upload and download times are for that route.
 */
export const FILES_THROUGH_COMMANDS: ReadonlySet<string> = new Set(["agentcore", "agent37", "boat"]);

const STAT = `grep '^cpu' /proc/stat 2> /dev/null | tr '\\n' ';'`;

/** One session's times, in ms as seen from the test machine. */
export interface AssistantSession {
  createMs: number;
  /** The first Python call, after the sandbox started. */
  firstMs: number;
  uploadMs: number;
  analyseMs: number;
  downloadMs: number;
  /** Each of the short tool calls, in order. */
  callMs: number[];
  /** The one call after the idle minute. */
  idleMs: number;
  /** From the first call to the last, idle minute included, without time spent waiting for another provider's file transfer. */
  sessionMs: number;
  /** CPU time the session used inside the sandbox, where the sandbox shows it. */
  cpuMs?: number;
  maxCoreMs?: number;
}

export interface AssistantSummary {
  /** Start plus the first call: how long until the assistant has its first result. Median. */
  firstAnswerMs?: number;
  uploadMs?: number;
  analyseMs?: number;
  downloadMs?: number;
  /** Median and 95th percentile of every short call of every session. */
  callMs?: number;
  callP95Ms?: number;
  idleMs?: number;
}

export interface AssistantRow extends AssistantSummary {
  provider: string;
  size: { vcpu: number; memoryGb: number };
  /** Sessions where every step finished and checked out. */
  sessions: AssistantSession[];
  /** Sessions that did not start, stopped part-way, or returned something wrong. */
  failures: number;
  /** Published prices applied to one session's measured time and CPU use, median. */
  sessionUsd?: number;
  /** List price per hour at this size. */
  hourlyUsd?: number;
}

/** A saved assistant session report (results/, tool "sandboxrouter-assistant"). */
export interface AssistantReport {
  tool: "sandboxrouter-assistant";
  version: string;
  /** The session's version: a change to the steps makes older reports stop counting. */
  task: string;
  date: string;
  label?: string;
  by?: string;
  spec: { vcpu: number; memoryGb: number };
  /** Sessions asked of each provider. */
  runs: number;
  calls: number;
  idleSeconds: number;
  uploadBytes: number;
  downloadBytes: number;
  node: string;
  platform: string;
  rows: AssistantRow[];
}

export function assistantSummary(sessions: AssistantSession[]): AssistantSummary {
  if (!sessions.length) return {};
  const calls = sessions.flatMap((s) => s.callMs).sort((a, b) => a - b);
  return {
    firstAnswerMs: median(sessions.map((s) => s.createMs + s.firstMs)),
    uploadMs: median(sessions.map((s) => s.uploadMs)),
    analyseMs: median(sessions.map((s) => s.analyseMs)),
    downloadMs: median(sessions.map((s) => s.downloadMs)),
    callMs: median(calls),
    callP95Ms: percentile(calls, 0.95),
    idleMs: median(sessions.map((s) => s.idleMs)),
  };
}

export interface AssistantOptions {
  router: Router;
  providers: ProviderId[];
  runs?: number;
  spec?: { vcpu: number; memoryGb: number };
  onProgress?: (message: string) => void;
  /** For tests. */
  sleep?: (ms: number) => Promise<void>;
  idleSeconds?: number;
}

/** Providers side by side, each running its sessions one after another. File transfers take turns, so they do not share the test machine's connection. */
export async function assistant(opts: AssistantOptions): Promise<AssistantRow[]> {
  const runs = opts.runs ?? 3;
  const idle = (opts.idleSeconds ?? ASSISTANT_IDLE_SECONDS) * 1000;
  const asked = opts.spec ?? { vcpu: DEFAULT_VCPU, memoryGb: DEFAULT_MEMORY_GB };
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fixture = assistantFixture();
  const csv = new TextEncoder().encode(fixture.csv);

  let line: Promise<unknown> = Promise.resolve();
  const alone = <T>(work: () => Promise<T>): Promise<T> => {
    const mine = line.then(work, work);
    line = mine.catch(() => {});
    return mine;
  };
  const timed = async (work: () => Promise<void>) => {
    const t = performance.now();
    await work();
    return Math.max(1, Math.round(performance.now() - t));
  };

  const session = async (provider: ProviderId, spec: SandboxSpec): Promise<AssistantSession> => {
    const run = async (box: Awaited<ReturnType<Router["create"]>>, cmd: string, want: string, what: string) => {
      const r = await box.exec(cmd, { timeoutSeconds: 120 });
      if (r.exitCode !== 0) throw new Error(`${what} exited ${r.exitCode}: ${r.stderr.slice(-160)}`);
      if (r.stdout.replace(/\r/g, "").trim() !== want) throw new Error(`${what} returned something else`);
    };
    let box: Awaited<ReturnType<Router["create"]>> | undefined;
    try {
      const t0 = performance.now();
      box = await opts.router.create(spec, { provider, fallback: false, deadlineSeconds: 180 });
      const live = box;
      const createMs = Math.max(1, Math.round(performance.now() - t0));
      const s0 = performance.now();
      // Time spent waiting for another provider's transfer is not part of this session.
      let waited = 0;
      const transfer = async (work: () => Promise<void>) => {
        const t = performance.now();
        const ms = await alone(() => timed(work));
        waited += Math.max(0, performance.now() - t - ms);
        return ms;
      };
      const firstMs = await timed(() => run(live, ASSISTANT_FIRST, "42", "the first call"));
      const before = (await live.exec(`mkdir -p ${DIR}; ${STAT}`)).stdout;
      const uploadMs = await transfer(() => live.writeFile(`${DIR}/data.csv`, csv));
      const analyseMs = await timed(() => run(live, ASSISTANT_ANALYSE, fixture.summary, "the analysis"));
      const downloadMs = await transfer(async () => {
        const bytes = await live.readFile(`${DIR}/top.csv`);
        if (createHash("sha256").update(bytes).digest("hex") !== fixture.resultSha256) throw new Error("the downloaded file is not the one the analysis wrote");
      });
      const callMs: number[] = [];
      for (let i = 1; i <= ASSISTANT_CALLS; i++) callMs.push(await timed(() => run(live, ASSISTANT_CALL, String(i), `call ${i}`)));
      await sleep(idle);
      const idleMs = await timed(() => run(live, ASSISTANT_CALL, String(ASSISTANT_CALLS + 1), "the call after idle"));
      const sessionMs = Math.max(1, Math.round(performance.now() - s0 - waited));
      const after = (await live.exec(STAT)).stdout;
      const cpu = busyMs(before, after);
      const plausible = cpu !== undefined && cpu <= (spec.vcpu ?? DEFAULT_VCPU) * sessionMs * 1.1;
      const core = plausible ? maxCoreMs(before, after) : undefined;
      return { createMs, firstMs, uploadMs, analyseMs, downloadMs, callMs, idleMs, sessionMs, ...(plausible ? { cpuMs: cpu } : {}), ...(core !== undefined ? { maxCoreMs: core } : {}) };
    } finally {
      await box?.kill().catch(() => {});
    }
  };

  return Promise.all(
    opts.providers.map(async (provider): Promise<AssistantRow> => {
      // Mostly idle, like the agent job: providers that reserve CPU by expected use start with that hint.
      const spec: SandboxSpec = { ...asked, ...fixedSize(provider, asked), timeoutMinutes: 15, cpuUtilization: 0.1 };
      const size = sizeOf(provider, spec);
      const done: AssistantSession[] = [];
      let failures = 0;
      for (let i = 0; i < runs; i++) {
        try {
          const s = await session(provider, spec);
          done.push(s);
          opts.onProgress?.(`${provider} session ${i + 1}/${runs}: first answer ${s.createMs + s.firstMs} ms, upload ${s.uploadMs} ms, download ${s.downloadMs} ms, after idle ${s.idleMs} ms`);
        } catch (e) {
          failures++;
          opts.onProgress?.(`${provider} session ${i + 1}/${runs} failed: ${(e as Error).message.replace(/\s+/g, " ").slice(0, 200)}`);
        }
      }
      let hourlyUsd: number | undefined;
      let sessionUsd: number | undefined;
      try {
        hourlyUsd = hourlyCost(provider, { ...spec, cpuUtilization: 1 });
        const ratio = BILLED_VS_LIST[provider]?.ratio ?? 1;
        const usd = done.map((s) => Math.round(taskUsd(provider, { ...size, cpuUtilization: 0.1 }, s.createMs, s.sessionMs, s.cpuMs, ratio, false, s.maxCoreMs) * 1e9));
        if (usd.length) sessionUsd = median(usd)! / 1e9;
      } catch {
        /* no price: the row still stands */
      }
      return {
        provider, size, sessions: done, ...assistantSummary(done), failures,
        ...(sessionUsd !== undefined ? { sessionUsd } : {}),
        ...(hourlyUsd !== undefined ? { hourlyUsd } : {}),
      };
    }),
  );
}

export function loadAssistantReports(dir: string): AssistantReport[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: AssistantReport[] = [];
  for (const f of files.sort()) {
    try {
      const r = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (r?.tool === "sandboxrouter-assistant" && Array.isArray(r.rows)) out.push(r);
    } catch {
      /* skip unreadable files */
    }
  }
  return out;
}

const KNOWN = new Set<string>(CATALOG.map((c) => c.id));

/**
 * For the website: each provider's newest report of the current session. A provider is listed only when
 * every session of that report finished and checked out. Fastest first answer first.
 */
export function assistantTable(reports: AssistantReport[]) {
  const latest = new Map<string, { row: AssistantRow; rep: AssistantReport }>();
  for (const rep of reports) {
    if (rep.task !== ASSISTANT_VERSION) continue;
    for (const row of rep.rows) {
      if (!KNOWN.has(row.provider) || !benchmarksPublishable(row.provider as ProviderId)) continue;
      const seen = latest.get(row.provider);
      if (!seen || rep.date > seen.rep.date) latest.set(row.provider, { row, rep });
    }
  }
  return [...latest.values()]
    .filter(({ row, rep }) => row.failures === 0 && row.sessions.length === rep.runs && row.firstAnswerMs !== undefined)
    .map(({ row, rep }) => ({
      provider: row.provider,
      name: CATALOG.find((c) => c.id === row.provider)!.name,
      size: row.size,
      firstAnswerMs: row.firstAnswerMs!,
      uploadMs: row.uploadMs!,
      analyseMs: row.analyseMs!,
      downloadMs: row.downloadMs!,
      callMs: row.callMs!,
      callP95Ms: row.callP95Ms!,
      idleMs: row.idleMs!,
      runs: rep.runs,
      calls: rep.calls,
      idleSeconds: rep.idleSeconds,
      uploadBytes: rep.uploadBytes,
      downloadBytes: rep.downloadBytes,
      ...(row.sessionUsd !== undefined ? { sessionUsd: row.sessionUsd } : {}),
      ...(row.hourlyUsd !== undefined ? { hourlyUsd: row.hourlyUsd } : {}),
      ...(FILES_THROUGH_COMMANDS.has(row.provider) ? { filesThroughCommands: true } : {}),
      measuredAt: rep.date,
    }))
    .sort((a, b) => a.firstAnswerMs - b.firstAnswerMs);
}
