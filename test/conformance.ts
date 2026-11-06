import { fixedSize } from "../src/catalog.js";
import { existsSync, realpathSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Router } from "../src/router.js";
import type { Provider, SandboxSpec } from "../src/types.js";
import { shq } from "../src/util.js";

/**
 * The sandbox contract from CONTRIBUTING.md ("Adding a provider"), as tests any adapter runs
 * against its own mock of the vendor API. The mock must really run commands with `sh`, so the
 * suite checks behavior, not call shapes:
 *
 *   - exec returns stdout, stderr and the exit code, applies cwd and env, and refuses a missing cwd
 *   - output streams through onStdout/onStderr and the full output is still returned
 *   - files are binary-safe at nested paths and shared with commands
 *   - a command that outlives timeoutSeconds is stopped and exec rejects with
 *     `<provider>: command timed out after Ns` (while `exit 124` by the command itself is a result)
 *   - connect() reaches the same sandbox, pause() keeps files for connect() to resume, kill() ends it
 *
 * Usage, after the mock is up:  describeConformance("koyeb", { provider: () => new KoyebProvider(...), dir: root });
 * The provider must report configured() as true (give it credentials, or set its env vars), since the
 * suite creates sandboxes through the Router, which skips unconfigured providers.
 */
export interface ConformanceOptions {
  /** A fresh adapter per test, pointed at the mock. */
  provider: () => Provider | Promise<Provider>;
  /** An absolute directory that both the files API and commands reach at this same path. */
  dir: string;
  /** Spec passed to every create (e.g. an image the mock expects). */
  spec?: SandboxSpec;
  /** Set when the adapter has no live streaming: output may then arrive in one chunk at the end. */
  noStreaming?: string;
  /** Seconds a timed-out exec may take to reject. The adapter must do this itself: the router's own net comes EXEC_GRACE_S later. */
  timeoutRejectWithinS?: number;
}

export function describeConformance(name: string, opts: ConformanceOptions) {
  const path = (file: string) => `${opts.dir}/${file}`;

  describe(`${name}: sandbox contract`, () => {
    async function start() {
      const p = await opts.provider();
      const router = new Router({ providers: [p], ledger: false });
      const sbx = await router.create(opts.spec ?? { ...fixedSize(p.id) }, { provider: p.id, fallback: false });
      return { p, router, sbx };
    }

    it("exec returns stdout, stderr and the exit code", async () => {
      const { sbx } = await start();
      try {
        expect(await sbx.exec("printf hi; printf err >&2; exit 3")).toMatchObject({ exitCode: 3, stdout: "hi", stderr: "err" });
        expect((await sbx.exec("true")).exitCode).toBe(0);
      } finally {
        await sbx.kill();
      }
    });

    it("applies env and cwd, and does not run the command when the cwd is missing", async () => {
      const { sbx } = await start();
      try {
        const r = await sbx.exec('printf "%s %s" "$SBR_CHECK" "$(pwd)"', { env: { SBR_CHECK: "v1" }, cwd: opts.dir });
        const [value, cwd] = r.stdout.trim().split(" ");
        expect(value).toBe("v1");
        // `pwd` may print the logical or the physical path (/tmp vs /private/tmp on macOS).
        expect([opts.dir, realpathSync(opts.dir)]).toContain(cwd);

        const marker = path("ran-anyway");
        const missing = sbx.exec(`echo ran > ${shq(marker)}`, { cwd: path("no-such-dir"), env: { A: "1" } });
        await missing.then(
          (res) => expect(res.exitCode).not.toBe(0),
          () => undefined, // an error for a missing cwd is fine too
        );
        expect(existsSync(marker)).toBe(false);
      } finally {
        await sbx.kill();
      }
    });

    it("streams output as it arrives and still returns all of it", async () => {
      const { sbx } = await start();
      try {
        const out: string[] = [];
        const err: string[] = [];
        const t0 = Date.now();
        let firstAt = -1;
        const r = await sbx.exec("echo one; sleep 0.7; echo two; echo warn >&2", {
          onStdout: (c) => {
            if (firstAt < 0) firstAt = Date.now() - t0;
            out.push(c);
          },
          onStderr: (c) => err.push(c),
        });
        const total = Date.now() - t0;
        expect(r).toMatchObject({ exitCode: 0, stdout: "one\ntwo\n", stderr: "warn\n" });
        expect(out.join("")).toBe(r.stdout);
        expect(err.join("")).toBe(r.stderr);
        if (!opts.noStreaming) expect(firstAt).toBeLessThan(total - 400);
      } finally {
        await sbx.kill();
      }
    });

    it("moves files as bytes at nested paths, shared with commands", async () => {
      const { sbx } = await start();
      try {
        const bytes = new Uint8Array(1024).map((_, i) => i % 256);
        const file = path("nested/deep/bin.dat");
        await sbx.writeFile(file, bytes);
        expect(Buffer.from(await sbx.readFile(file)).equals(Buffer.from(bytes))).toBe(true);
        expect((await sbx.exec(`wc -c < ${shq(file)}`)).stdout.trim()).toBe("1024");

        await sbx.writeFile(path("hello.txt"), "hello from writeFile\n");
        const r = await sbx.exec(`cat ${shq(path("hello.txt"))} && printf made > ${shq(path("made.txt"))}`);
        expect(r.stdout).toBe("hello from writeFile\n");
        expect(await sbx.readText(path("made.txt"))).toBe("made");
      } finally {
        await sbx.kill();
      }
    });

    it("stops a command at its timeout and rejects with the contract's error", async () => {
      const { p, sbx } = await start();
      try {
        const late = path("late");
        const t0 = Date.now();
        await expect(sbx.exec(`sleep 3; echo late > ${shq(late)}`, { timeoutSeconds: 1 })).rejects.toMatchObject({
          name: "ProviderError",
          message: `${p.id}: command timed out after 1s`,
        });
        expect(Date.now() - t0).toBeLessThan((opts.timeoutRejectWithinS ?? 8) * 1000);
        // The command was stopped, not just abandoned: it never gets to write the file.
        await new Promise((r) => setTimeout(r, 3500));
        expect(existsSync(late)).toBe(false);
        // A command that exits 124 by itself is a result, not a timeout.
        expect((await sbx.exec("exit 124", { timeoutSeconds: 5 })).exitCode).toBe(124);
      } finally {
        await sbx.kill();
      }
    }, 20_000);

    it("connect reaches the same sandbox, and pause keeps its files for connect to resume", async () => {
      const { router, sbx } = await start();
      try {
        await sbx.writeFile(path("keep.txt"), "kept");
        const again = await router.get(sbx.id);
        expect(again.id).toBe(sbx.id);
        expect(await again.readText(path("keep.txt"))).toBe("kept");
        if (sbx.canPause) {
          await sbx.pause();
          const resumed = await router.get(sbx.id);
          expect(await resumed.readText(path("keep.txt"))).toBe("kept");
          expect((await resumed.exec("echo awake")).stdout.trim()).toBe("awake");
        }
      } finally {
        await sbx.kill();
      }
    });

    it("kill ends the sandbox", async () => {
      const { router, sbx } = await start();
      await sbx.kill();
      await expect(router.get(sbx.id).then((again) => again.exec("echo still-here", { timeoutSeconds: 5 }))).rejects.toThrow();
    });
  });
}
