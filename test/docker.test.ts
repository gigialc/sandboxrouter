import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DockerProvider } from "../src/providers/docker.js";
import { guardTimeout } from "../src/util.js";
import { describeConformance } from "./conformance.js";

/**
 * A fake `docker` CLI (sh wrapper around a small Node script) handed to DockerProvider's
 * constructor. It emulates the subcommands the adapter uses, with Docker's own exit codes and
 * daemon messages: `info --format`, `run -d --rm --name N [--label] [--cpus] [--memory] [-e]...
 * IMAGE CMD...` (records the container, runs nothing; exit 125 for an image that can't be pulled),
 * `exec [-i] [-w DIR] [-e K=V]... N ARGV...` (runs ARGV with the container's env plus -e in a
 * per-container dir or -w, stdin and output passed through; 126 for a missing cwd, 1 for a paused
 * or missing container), `inspect -f {{.State.Status}}`, `pause`, `unpause` and `rm -f`. Every
 * invocation is appended to calls.log. The adapter's guardTimeout needs `timeout` (or pkill),
 * so the wrapper puts a shim on PATH where coreutils is missing.
 */
const root = mkdtempSync(join(tmpdir(), "sbr-docker-"));
const state = join(root, "state");
const shims = join(root, "bin");
const bin = join(root, "docker");
const log = join(root, "calls.log");

const FAKE = String.raw`
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), { spawn } = require("node:child_process");
const STATE = process.argv[2], args = process.argv.slice(3);
fs.appendFileSync(path.join(STATE, "..", "calls.log"), JSON.stringify(args) + "\n");
const fail = (code, msg) => { process.stderr.write(msg + "\n"); process.exit(code); };
const file = (n) => path.join(STATE, n + ".json");
const load = (n) => { try { return JSON.parse(fs.readFileSync(file(n), "utf8")); } catch { return null; } };
const kv = (o, s) => { const i = s.indexOf("="); o[s.slice(0, i)] = s.slice(i + 1); };
const [verb, ...rest] = args;
if (verb === "info") { process.stdout.write("27.3.1\n"); }
else if (verb === "run") {
  const c = { status: "running", env: {}, labels: {}, flags: {} }; let i = 0, name;
  while (i < rest.length && rest[i].startsWith("-")) {
    const f = rest[i++]; if (f === "-d" || f === "--rm") continue; const v = rest[i++];
    if (f === "--name") name = v; else if (f === "-e") kv(c.env, v); else if (f === "--label") kv(c.labels, v); else c.flags[f] = v;
  }
  c.image = rest[i]; c.cmd = rest.slice(i + 1);
  if (c.image === "no/such:image") fail(125, "Unable to find image 'no/such:image' locally\ndocker: Error response from daemon: pull access denied for no/such, repository does not exist or may require 'docker login'.");
  fs.mkdirSync(path.join(STATE, name), { recursive: true });
  fs.writeFileSync(file(name), JSON.stringify(c));
  process.stdout.write(crypto.randomBytes(32).toString("hex") + "\n");
} else if (verb === "exec") {
  let i = 0, cwd, env = {};
  while (rest[i].startsWith("-")) { const f = rest[i++]; if (f === "-i") continue; const v = rest[i++]; if (f === "-w") cwd = v; else if (f === "-e") kv(env, v); }
  const name = rest[i++], argv = rest.slice(i), c = load(name);
  if (!c) fail(1, "Error response from daemon: No such container: " + name);
  if (c.status === "paused") fail(1, "Error response from daemon: Container " + name + " is paused, unpause the container before exec");
  cwd = cwd ?? path.join(STATE, name);
  if (!fs.existsSync(cwd)) fail(126, 'OCI runtime exec failed: exec failed: unable to start container process: chdir to cwd ("' + cwd + '") set in config.json failed: no such file or directory: unknown');
  const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...c.env, ...env }, stdio: "inherit" });
  child.on("error", (e) => fail(126, "OCI runtime exec failed: " + e.message));
  child.on("close", (code, signal) => process.exit(code ?? (signal === "SIGKILL" ? 137 : 143)));
} else if (verb === "inspect" || verb === "pause" || verb === "unpause" || verb === "rm") {
  const name = rest[rest.length - 1], c = load(name);
  if (!c) fail(1, verb === "inspect" ? "Error: No such object: " + name : "Error response from daemon: No such container: " + name);
  if (verb === "inspect") process.stdout.write(c.status + "\n");
  else if (verb === "rm") { fs.rmSync(file(name)); process.stdout.write(name + "\n"); }
  else { c.status = verb === "pause" ? "paused" : "running"; fs.writeFileSync(file(name), JSON.stringify(c)); process.stdout.write(name + "\n"); }
} else fail(1, "docker: unknown command: " + verb);
`;

const calls = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
const container = (name: string) => JSON.parse(readFileSync(join(state, `${name}.json`), "utf8"));

beforeAll(() => {
  mkdirSync(state);
  mkdirSync(shims);
  writeFileSync(log, "");
  if (spawnSync("sh", ["-c", "command -v timeout"], { stdio: "ignore" }).status !== 0) {
    writeFileSync(
      join(shims, "timeout"),
      [
        "#!/bin/sh",
        "# coreutils timeout for hosts without it: timeout [-k N|--kill-after=N] N cmd...",
        'while :; do case "$1" in -k) shift 2 ;; --kill-after=*) shift ;; *) break ;; esac; done',
        's=$1; shift',
        '"$@" & p=$!',
        "# Freeze the shell, end its children, then the shell; the grace sleep is reaped with the watchdog.",
        '( sleep "$s"; kill -STOP $p; pkill -TERM -P $p; kill -TERM $p; kill -CONT $p; sleep 5; pkill -KILL -P $p; kill -KILL $p ) >/dev/null 2>&1 & w=$!',
        "wait $p 2>/dev/null; c=$?",
        "pkill -P $w >/dev/null 2>&1; kill $w >/dev/null 2>&1",
        "[ $c -eq 143 ] && exit 124",
        "exit $c",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  }
  writeFileSync(join(root, "docker.cjs"), FAKE);
  writeFileSync(bin, `#!/bin/sh\nPATH='${shims}':"$PATH"; export PATH\nexec '${process.execPath}' '${join(root, "docker.cjs")}' '${state}' "$@"\n`, { mode: 0o755 });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const p = () => new DockerProvider(bin);

describeConformance("docker", { provider: p, dir: root });

describe("DockerProvider", () => {
  it("is configured when the CLI answers `info`, by constructor or SANDBOXROUTER_DOCKER_BIN", () => {
    expect(p().configured()).toBe(true);
    expect(new DockerProvider(join(root, "no-such-docker")).configured()).toBe(false);
    expect(calls().at(-1)).toEqual(["info", "--format", "{{.ServerVersion}}"]);
    const saved = process.env.SANDBOXROUTER_DOCKER_BIN;
    process.env.SANDBOXROUTER_DOCKER_BIN = bin;
    try {
      expect(new DockerProvider().configured()).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.SANDBOXROUTER_DOCKER_BIN;
      else process.env.SANDBOXROUTER_DOCKER_BIN = saved;
    }
  });

  it("runs a detached, self-removing container sized from the spec whose main process is the lifetime timer", async () => {
    const sbx = await p().create({ vcpu: 1, memoryGb: 0.5, timeoutMinutes: 2, env: { A: "1" }, metadata: { team: "x" }, image: { docker: "node:22-slim" } });
    expect(sbx.nativeId).toMatch(/^sbr-[0-9a-f-]{12}$/);
    expect(calls().at(-1)).toEqual([
      "run", "-d", "--rm", "--name", sbx.nativeId, "--label", "sandboxrouter=1", "--cpus", "1", "--memory", "512m",
      "-e", "A=1", "--label", "team=x", "node:22-slim", "sleep", "120",
    ]);
    expect((await sbx.exec("echo $A")).stdout).toBe("1\n");
    await sbx.kill();
    expect(calls().at(-1)).toEqual(["rm", "-f", sbx.nativeId]);
    expect(existsSync(join(state, `${sbx.nativeId}.json`))).toBe(false);

    const dflt = await p().create({});
    expect(calls().at(-1)!.slice(7)).toEqual(["--cpus", "2", "--memory", "4096m", "python:3.12-slim", "sleep", "1800"]);
    await dflt.kill();
    const short = await p().create({ timeoutMinutes: 0.1 });
    expect(calls().at(-1)!.slice(-2)).toEqual(["sleep", "60"]);
    await short.kill();
  });

  it("maps CLI failures to ProviderError", async () => {
    await expect(p().create({ image: { docker: "no/such:image" } })).rejects.toMatchObject({ name: "ProviderError", message: expect.stringMatching(/^docker: docker run failed: Unable to find image/) });
    await expect(new DockerProvider(join(root, "no-such-docker")).create({})).rejects.toThrow(/could not run .*no-such-docker: spawn .* ENOENT/);
    await expect(p().connect("sbr-missing")).rejects.toMatchObject({ status: 404, message: "docker: no container sbr-missing" });
    const sbx = await p().create({});
    await expect(sbx.readFile(join(root, "missing"))).rejects.toMatchObject({ status: 404, message: expect.stringContaining("No such file") });
    await sbx.kill();
  });

  it("passes cwd and env as exec flags and guards the command with coreutils timeout inside the container", async () => {
    const sbx = await p().create({});
    const r = await sbx.exec('printf "%s %s" "$K" "$(pwd)"', { cwd: root, env: { K: "v" }, timeoutSeconds: 7 });
    expect(r.stdout.split(" ")[0]).toBe("v");
    expect(calls().at(-1)).toEqual(["exec", "-i", "-w", root, "-e", "K=v", sbx.nativeId, "sh", "-c", guardTimeout('printf "%s %s" "$K" "$(pwd)"', 7)]);
    const t0 = Date.now();
    await expect(sbx.exec("sleep 5", { timeoutSeconds: 1 })).rejects.toThrow("docker: command timed out after 1s");
    expect(Date.now() - t0).toBeLessThan(4000);
    expect((await sbx.exec("exit 124")).exitCode).toBe(124);
    // writeFile streams the bytes over docker's stdin.
    await sbx.writeFile(join(root, "in", "x.bin"), new Uint8Array([0, 1, 2, 255]));
    expect(calls().at(-1)).toEqual(["exec", "-i", sbx.nativeId, "sh", "-c", `mkdir -p '${join(root, "in")}' && cat > '${join(root, "in", "x.bin")}'`]);
    expect([...readFileSync(join(root, "in", "x.bin"))]).toEqual([0, 1, 2, 255]);
    await sbx.readFile(join(root, "in", "x.bin"));
    expect(calls().at(-1)).toEqual(["exec", sbx.nativeId, "cat", join(root, "in", "x.bin")]);
    await sbx.kill();
  });

  it("pause freezes the container and connect unpauses it", async () => {
    const sbx = await p().create({});
    await sbx.pause!();
    expect(calls().at(-1)).toEqual(["pause", sbx.nativeId]);
    expect(container(sbx.nativeId).status).toBe("paused");
    // Docker refuses to exec into a paused container; the adapter reports the exit, not a crash.
    const paused = await sbx.exec("echo nope");
    expect(paused.exitCode).toBe(1);
    expect(paused.stderr).toContain("is paused");
    const again = await p().connect(sbx.nativeId);
    expect(calls().slice(-2)).toEqual([["inspect", "-f", "{{.State.Status}}", sbx.nativeId], ["unpause", sbx.nativeId]]);
    expect((await again.exec("echo awake")).stdout).toBe("awake\n");
    const n = calls().length;
    await p().connect(sbx.nativeId);
    expect(calls().slice(n)).toEqual([["inspect", "-f", "{{.State.Status}}", sbx.nativeId]]);
    await again.kill();
  });
});
