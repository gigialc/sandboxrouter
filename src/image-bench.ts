import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { benchmarksPublishable, CATALOG } from "./catalog.js";
import { median } from "./bench-store.js";
import type { Router } from "./router.js";
import type { ProviderId } from "./types.js";

/**
 * Image boot benchmark: start a sandbox straight from a public registry image reference, with no template,
 * snapshot or rebuild step in between, and time it.
 *
 * The first start includes the provider pulling and preparing the image, and happens once per image and
 * account, so it is one observation. The repeat starts come after it. Every sandbox runs a command whose
 * output must contain an expected text, so a provider that starts some other image is not counted.
 */

export interface ImageVerify {
  /** Run in every sandbox. */
  command: string;
  /** Its output must contain this, e.g. "Python 3.11". */
  contains: string;
}

export interface ImageRow {
  provider: string;
  size: { vcpu: number; memoryGb: number };
  /** Create time of the first start from this image, in ms. Missing when the first start failed. */
  firstCreateMs?: number;
  /** Create time of each later start that was verified, in ms. */
  repeatCreateMs: number[];
  medianRepeatCreateMs?: number;
  /** Starts whose sandbox ran the verify command and printed the expected text. */
  verified: number;
  /** Starts that failed, or whose sandbox was not the image asked for. */
  failures: number;
  /** List price per hour at this size. */
  hourlyUsd?: number;
}

/** A saved image boot report (results/, tool "sandboxrouter-image"). */
export interface ImageReport {
  tool: "sandboxrouter-image";
  version: string;
  date: string;
  label?: string;
  by?: string;
  /** The registry reference every provider was given. */
  image: string;
  verify: ImageVerify;
  spec: { vcpu: number; memoryGb: number };
  /** Starts after the first one. */
  repeats: number;
  node: string;
  platform: string;
  rows: ImageRow[];
}

export interface ImageBenchOptions {
  router: Router;
  providers: ProviderId[];
  image: string;
  verify: ImageVerify;
  spec: { vcpu: number; memoryGb: number };
  repeats?: number;
  /** Seconds to wait for one create. The first start of a large image can take minutes. */
  createTimeoutSeconds?: number;
  onProgress?: (message: string) => void;
}

/** One provider at a time per image, providers in parallel. */
export async function imageBench(opts: ImageBenchOptions): Promise<ImageRow[]> {
  const repeats = opts.repeats ?? 3;
  const timeout = opts.createTimeoutSeconds ?? 900;

  const start = async (provider: ProviderId): Promise<{ createMs?: number; size?: ImageRow["size"]; error?: string }> => {
    let sbx: Awaited<ReturnType<Router["create"]>> | undefined;
    try {
      const t0 = Date.now();
      sbx = await opts.router.create(
        { ...opts.spec, timeoutMinutes: 15, image: { [provider]: opts.image } },
        { provider, fallback: false, createTimeoutSeconds: timeout, deadlineSeconds: timeout },
      );
      const createMs = Date.now() - t0;
      const r = await sbx.exec(opts.verify.command, { timeoutSeconds: 60 });
      if (!`${r.stdout}${r.stderr}`.includes(opts.verify.contains)) return { error: "the sandbox is not the image asked for" };
      return { createMs, size: sbx.size };
    } catch (e) {
      return { error: (e as Error).message.replace(/\s+/g, " ").slice(0, 200) };
    } finally {
      await sbx?.kill().catch(() => {});
    }
  };

  return Promise.all(
    opts.providers.map(async (provider): Promise<ImageRow> => {
      const first = await start(provider);
      opts.onProgress?.(`${provider}: first start ${first.error ?? `${first.createMs} ms`}`);
      const later: Awaited<ReturnType<typeof start>>[] = [];
      if (!first.error) {
        for (let i = 0; i < repeats; i++) {
          const r = await start(provider);
          later.push(r);
          opts.onProgress?.(`${provider}: repeat start ${r.error ?? `${r.createMs} ms`}`);
        }
      }
      const ok = later.filter((r) => r.createMs !== undefined).map((r) => r.createMs!);
      let hourlyUsd: number | undefined;
      try {
        const plan = await opts.router.plan({ ...opts.spec, image: { [provider]: opts.image } }, { provider, fallback: false });
        hourlyUsd = plan[0]?.listHourlyUsd;
      } catch {
        /* no price: the row still stands */
      }
      return {
        provider,
        size: first.size ?? opts.spec,
        ...(first.createMs !== undefined ? { firstCreateMs: first.createMs } : {}),
        repeatCreateMs: ok,
        ...(ok.length ? { medianRepeatCreateMs: median(ok) } : {}),
        verified: (first.error ? 0 : 1) + ok.length,
        failures: (first.error ? 1 : 0) + later.length - ok.length,
        ...(hourlyUsd !== undefined ? { hourlyUsd } : {}),
      };
    }),
  );
}

export function loadImageReports(dir: string): ImageReport[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: ImageReport[] = [];
  for (const f of files.sort()) {
    try {
      const r = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (r?.tool === "sandboxrouter-image" && Array.isArray(r.rows)) out.push(r);
    } catch {
      /* skip unreadable files */
    }
  }
  return out;
}

const KNOWN = new Set<string>(CATALOG.map((c) => c.id));

/**
 * For the website: one table per image, each provider's latest run of that image. Only providers whose every
 * start was verified get a row with times; fastest repeat start first.
 */
export function imageTable(reports: ImageReport[]) {
  const images = new Map<string, { spec: ImageReport["spec"]; repeats: number; latest: Map<string, { row: ImageRow; date: string }> }>();
  for (const rep of reports) {
    const entry = images.get(rep.image) ?? { spec: rep.spec, repeats: rep.repeats, latest: new Map() };
    images.set(rep.image, entry);
    for (const r of rep.rows) {
      if (!KNOWN.has(r.provider) || !benchmarksPublishable(r.provider)) continue;
      const seen = entry.latest.get(r.provider);
      if (!seen || rep.date > seen.date) entry.latest.set(r.provider, { row: r, date: rep.date });
    }
  }
  return [...images.entries()]
    .map(([image, { spec, repeats, latest }]) => ({
      image,
      spec,
      repeats,
      rows: [...latest.values()]
        .filter(({ row }) => row.failures === 0 && row.medianRepeatCreateMs !== undefined && row.firstCreateMs !== undefined)
        .map(({ row, date }) => ({ ...row, name: CATALOG.find((c) => c.id === row.provider)!.name, measuredAt: date }))
        .sort((a, b) => a.medianRepeatCreateMs! - b.medianRepeatCreateMs!),
    }))
    .filter((t) => t.rows.length)
    .sort((a, b) => a.image.localeCompare(b.image));
}
