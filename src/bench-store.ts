import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ProviderId } from "./types.js";

export interface BenchSample {
  createMs: number[];
  execMs: number[];
  failures: number;
  at: string;
}

export type BenchData = Partial<Record<ProviderId, BenchSample>>;

/** $SANDBOXROUTER_BENCH_FILE, else bench.json next to the ledger: $SANDBOXROUTER_HOME, else ~/.sandboxrouter/. */
export function defaultBenchFile(): string {
  return process.env.SANDBOXROUTER_BENCH_FILE || join(process.env.SANDBOXROUTER_HOME || join(homedir(), ".sandboxrouter"), "bench.json");
}

export function loadBench(file = defaultBenchFile()): BenchData {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as BenchData;
  } catch {
    return {};
  }
}

export function saveBench(data: BenchData, file = defaultBenchFile()) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2));
}

export function median(xs?: number[]): number | undefined {
  if (!xs || xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
