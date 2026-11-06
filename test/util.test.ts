import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { guardTimeout, killedByTimeout, shq, timeoutError, wrapCommand } from "../src/util.js";

/** Run shell text the way adapters do, in a real `sh` (by absolute path, so a restricted PATH only affects the script). */
function sh(script: string, env: Record<string, string> = {}) {
  const r = spawnSync("/bin/sh", ["-c", script], { encoding: "utf8", env: { ...process.env, ...env } });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("wrapCommand", () => {
  it("leaves a command without cwd or env untouched", () => {
    expect(wrapCommand("echo hi")).toBe("echo hi");
    expect(wrapCommand("echo hi", { env: {} })).toBe("echo hi");
  });

  it("sets cwd and env for the command", () => {
    const r = sh(wrapCommand(`echo "$A:$(pwd)"`, { cwd: "/", env: { A: "it's" } }));
    expect(r).toMatchObject({ code: 0, stdout: "it's:/\n" });
  });

  it("does not run the command when the cwd is missing, and reports the failure", () => {
    const r = sh(wrapCommand("echo ran", { cwd: "/no/such/dir", env: { A: "1" } }));
    expect(r.code).not.toBe(0);
    expect(r.stdout).toBe("");
    // The wording is the shell's (bash: "No such file or directory", dash: "can't cd to"); the path is what matters.
    expect(r.stderr).toContain("/no/such/dir");
  });

  it("keeps the command's own `;` and `||` inside the guarded group", () => {
    // Without the group, `false; echo ran` would run `echo ran` even after a failed cd.
    const r = sh(wrapCommand("false; echo ran", { cwd: "/no/such/dir" }));
    expect(r.stdout).toBe("");
    expect(sh(wrapCommand("false || echo fallback", { cwd: "/" })).stdout).toBe("fallback\n");
  });

  it("returns the command's own exit code", () => {
    expect(sh(wrapCommand("exit 7", { cwd: "/", env: { A: "1" } })).code).toBe(7);
  });

  it("survives a trailing comment and a value with quotes", () => {
    expect(sh(wrapCommand("echo ok # done", { cwd: "/" })).stdout).toBe("ok\n");
    expect(sh(wrapCommand(`printf %s "$Q"`, { env: { Q: `a'b"c $HOME` } })).stdout).toBe(`a'b"c $HOME`);
  });

  it("refuses an invalid env var name", () => {
    expect(() => wrapCommand("true", { env: { "bad-name": "x" } })).toThrow(/invalid env var name/);
  });
});

describe("timeout helpers", () => {
  it("timeoutError has the one message every adapter uses", () => {
    const e = timeoutError("boat", 3);
    expect(e).toMatchObject({ name: "ProviderError", provider: "boat", message: "boat: command timed out after 3s" });
  });

  it("killedByTimeout needs both a kill exit code and the elapsed time", () => {
    expect(killedByTimeout(124, 3000, 3)).toBe(true);
    expect(killedByTimeout(137, 2800, 3)).toBe(true); // clocks differ a little
    expect(killedByTimeout(143, 3000, 3)).toBe(true);
    expect(killedByTimeout(-1, 3000, 3)).toBe(true); // signal death, or "no exit code"
    expect(killedByTimeout(124, 50, 3)).toBe(false); // `exit 124` by the command itself
    expect(killedByTimeout(0, 3000, 3)).toBe(false);
    expect(killedByTimeout(1, 3000, 3)).toBe(false);
  });
});

describe("guardTimeout", () => {
  const root = mkdtempSync(join(tmpdir(), "sbr-util-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** A PATH with only sh, sleep (kill is a builtin) and `extra`, so the coreutils `timeout` branch cannot be taken. */
  function bareBin(...extra: string[]): string {
    const dir = join(root, `bare-bin-${extra.join("-") || "min"}`);
    if (existsSync(dir)) return dir;
    mkdirSync(dir);
    for (const tool of ["sh", "sleep", ...extra]) {
      const real = spawnSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
      if (!real) throw new Error(`cannot find ${tool} to build the bare PATH`);
      symlinkSync(real, join(dir, tool));
    }
    return dir;
  }

  it("lets a quick command finish with its own output and exit code", () => {
    expect(sh(guardTimeout("echo hi; exit 5", 5))).toMatchObject({ code: 5, stdout: "hi\n" });
  });

  it("kills a command that outlives the deadline, with a kill exit code", () => {
    const t0 = Date.now();
    const r = sh(guardTimeout("sleep 10; echo late", 1));
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(r.stdout).toBe("");
    expect(killedByTimeout(r.code ?? -1, Date.now() - t0, 1)).toBe(true);
  }, 15_000);

  it("falls back to a shell watchdog when the image has no `timeout`", () => {
    const t0 = Date.now();
    // Without `pkill` the watchdog can only kill the command's shell, so the orphaned `sleep` keeps
    // running; it is detached from our pipes here so spawnSync returns when the shell dies.
    const r = sh(guardTimeout("sleep 10 >/dev/null 2>&1; echo late", 1), { PATH: bareBin() });
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(r.stdout).toBe("");
    expect(killedByTimeout(r.code ?? -1, Date.now() - t0, 1)).toBe(true);
    // And a healthy command still works there.
    expect(sh(guardTimeout("echo hi", 2), { PATH: bareBin() })).toMatchObject({ code: 0, stdout: "hi\n" });
  }, 15_000);

  it("with `pkill` but no `timeout`, the watchdog also stops the command's children", () => {
    const t0 = Date.now();
    const r = sh(guardTimeout("sleep 10; echo late", 1), { PATH: bareBin("pkill") });
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(r.stdout).toBe("");
    expect(killedByTimeout(r.code ?? -1, Date.now() - t0, 1)).toBe(true);
  }, 15_000);

  it("quotes the command once, so the command's own quoting is preserved", () => {
    expect(sh(guardTimeout(`printf %s ${shq("it's \"here\"")}`, 2)).stdout).toBe(`it's "here"`);
  });
});
