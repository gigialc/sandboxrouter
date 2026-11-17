import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

// Ranking reads the bench file on every create: keep what was read, and read again only when it changed.
const cache = new Map<string, { mtimeMs: number; size: number; data: BenchData }>();

export function loadBench(file = defaultBenchFile()): BenchData {
  try {
    const { mtimeMs, size } = statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.data;
    const data = JSON.parse(readFileSync(file, "utf8")) as BenchData;
    cache.set(file, { mtimeMs, size, data });
    return data;
  } catch {
    return {};
  }
}

export function saveBench(data: BenchData, file = defaultBenchFile()) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2));
  cache.delete(file);
}

export function median(xs?: number[]): number | undefined {
  if (!xs || xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
