import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExeDevProvider } from "../src/providers/exedev.js";
import { describeConformance } from "./conformance.js";

/**
 * A stand-in for https://exe.dev/exec, the one endpoint behind `ssh exe.dev`: POST with a Bearer
 * token and the command line as text/plain. Lobby commands (`new --standalone ...`, `ls`, `rm <vm>`,
 * all with `--json`) answer JSON; `ssh <vm> 'bash -c "$(echo <b64> | base64 -d)"'` with
 * Accept: application/x-ndjson decodes the script, really runs it with bash in a per-VM temp dir
 * and streams {"stdout":b64} / {"stderr":b64} lines then {"exit_code":N} ({"error":...} for an
 * unknown VM). The adapter's own detach-and-poll scheme (setsid nohup, `timeout -k 5 N`,
 * /tmp/.sbr-<job>/{out,err,exit}) runs as-is, except that the VM's /tmp is a directory of its own
 * rather than the host's; the VM image's GNU tools missing on macOS (timeout, setsid,
 * `base64 -w0 FILE`) get minimal shims on PATH.
 */
const root = mkdtempSync(join(tmpdir(), "sbr-exedev-"));
const shims = join(root, "bin");
let server: Server;
let base = "";
const vms = new Map<string, { dir: string }>();
const seen: { auth?: string; accept?: string; command: string }[] = [];
const groups = new Set<number>();
let newError: string | undefined;

/** The command and decoded script of every `ssh` request so far. */
const scripts = () =>
  seen
    .map((s) => /^ssh (\S+) 'bash -c "\$\(echo ([A-Za-z0-9+/=]+) \| base64 -d\)"'$/.exec(s.command))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ vm: m[1], script: Buffer.from(m[2], "base64").toString() }));

function installShims() {
  mkdirSync(shims);
  const missing = (probe: string) => spawnSync("sh", ["-c", probe], { stdio: "ignore" }).status !== 0;
  const shim = (name: string, lines: string[]) => writeFileSync(join(shims, name), `${lines.join("\n")}\n`, { mode: 0o755 });
  if (missing("command -v timeout")) {
    shim("timeout", [
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
    ]);
  }
  if (missing("command -v setsid")) shim("setsid", ["#!/bin/sh", 'exec "$@"']);
  if (missing("base64 -w0 /dev/null")) {
    const real = spawnSync("sh", ["-c", "command -v base64"], { encoding: "utf8" }).stdout.trim();
    shim("base64", [
      "#!/bin/sh",
      "# GNU flags on a BSD base64: base64 [-d] [-w0] [FILE]",
      "dec=; file=",
      'for a in "$@"; do case "$a" in -d|--decode) dec=1 ;; -w*|--wrap=*|0) ;; *) file=$a ;; esac; done',
      '[ -n "$file" ] && exec < "$file"',
      `[ -n "$dec" ] && exec '${real}' -d`,
      `'${real}' | tr -d '\\n'`,
    ]);
  }
}

beforeAll(async () => {
  installShims();
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const command = Buffer.concat(chunks).toString();
    seen.push({ auth: req.headers.authorization, accept: req.headers.accept, command });
    const json = (status: number, obj: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.url !== "/exec" || req.method !== "POST") return json(404, { error: "not found" });
    if (req.headers.authorization !== "Bearer exe1_test") return json(401, { error: "invalid token" });
    const [verb] = command.split(" ", 1);

    if (verb === "new") {
      if (newError) return json(200, { error: newError });
      const flag = (k: string) => new RegExp(`--${k}=(\\S+)`).exec(command)?.[1];
      const name = flag("name")!;
      const dir = join(root, "vms", name);
      mkdirSync(join(dir, "tmp"), { recursive: true });
      vms.set(name, { dir });
      return json(200, { vm_name: name, status: "running", cpu: Number(flag("cpu")), memory: flag("memory"), image: flag("image") ?? "default" });
    }
    if (verb === "ls") return json(200, { vms: [...vms.keys()].map((vm_name) => ({ vm_name, status: "running" })) });
    if (verb === "rm") {
      const name = command.split(" ")[1];
      if (!vms.delete(name)) return json(200, { error: `VM ${name} not found` });
      return json(200, { deleted: name });
    }
    if (verb === "ssh") {
      const m = /^ssh (\S+) 'bash -c "\$\(echo ([A-Za-z0-9+/=]+) \| base64 -d\)"'$/.exec(command);
      if (!m) return json(400, { error: "unsupported ssh command line" });
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      const line = (o: unknown) => res.write(`${JSON.stringify(o)}\n`);
      const vm = vms.get(m[1]);
      if (!vm) {
        line({ error: `VM ${m[1]} not found` });
        return res.end();
      }
      // The VM has its own /tmp: keep the adapter's job dirs out of the host's.
      const script = Buffer.from(m[2], "base64").toString().replaceAll("/tmp/.sbr-", `${vm.dir}/tmp/.sbr-`);
      const child = spawn("bash", ["-c", script], { cwd: vm.dir, env: { ...process.env, PATH: `${shims}:${process.env.PATH}` }, detached: true });
      if (child.pid) groups.add(child.pid);
      child.stdout.on("data", (d: Buffer) => line({ stdout: d.toString("base64") }));
      child.stderr.on("data", (d: Buffer) => line({ stderr: d.toString("base64") }));
      // A request lasts at most 30 s; the adapter's polls stay well under it.
      const guard = setTimeout(() => child.kill("SIGKILL"), 30_000);
      child.on("close", (code) => {
        clearTimeout(guard);
        line({ exit_code: code ?? 137 });
        res.end();
      });
      return;
    }
    json(400, { error: `unknown command: ${verb}` });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
  // Detached jobs share their request's process group (the setsid shim keeps them there).
  for (const pid of groups) try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
  server.close();
  rmSync(root, { recursive: true, force: true });
});

const p = () => new ExeDevProvider("exe1_test", base);

// Streaming is real but coarse: each /exec request polls the job for up to a second and returns what
// was written since the last one, so the contract's 0.7 s command arrives in one piece.
describeConformance("exedev", { provider: p, dir: root, noStreaming: "output is polled once a second over /exec" });

describe("ExeDevProvider", () => {
  it("reports configured() from the token", () => {
    expect(new ExeDevProvider(undefined, base).configured()).toBe(false);
    expect(p().configured()).toBe(true);
  });

  it("creates a standalone VM with cpu, memory (2 GiB per vCPU) and image flags, then waits for ssh", async () => {
    seen.length = 0;
    const sbx = await p().create({ vcpu: 4, memoryGb: 8, image: { exedev: "ubuntu:24.04" } });
    expect(sbx.nativeId).toMatch(/^sbr-[0-9a-f]{12}$/);
    expect(seen[0]).toMatchObject({ auth: "Bearer exe1_test", command: `new --standalone --name=${sbx.nativeId} --cpu=4 --memory=8GB --image=ubuntu:24.04 --json` });
    expect(seen[1].accept).toBe("application/x-ndjson");
    expect(scripts()[0]).toEqual({ vm: sbx.nativeId, script: "true" });
    await sbx.kill();
    expect(seen.at(-1)!.command).toBe(`rm ${sbx.nativeId} --json`);

    seen.length = 0;
    await (await p().create({})).kill();
    expect(seen[0].command).toMatch(/^new --standalone --name=sbr-[0-9a-f]+ --cpu=2 --memory=4GB --json$/);
    seen.length = 0;
    await (await p().create({ vcpu: 1, memoryGb: 15.5 })).kill();
    expect(seen[0].command).toContain("--cpu=8 --memory=16GB");
    await expect(p().create({ image: { exedev: "bad image;rm -rf" } })).rejects.toThrow(/invalid image reference/);
  });

  it("maps /exec failures, lobby errors and the 64 KB body cap to ProviderError", async () => {
    await expect(new ExeDevProvider("exe1_wrong", base).create({})).rejects.toMatchObject({ name: "ProviderError", status: 401, message: "exedev: /exec new -> 401 invalid token" });
    newError = "quota exceeded: 3 standalone VMs";
    try {
      await expect(p().create({})).rejects.toThrow("exedev: new: quota exceeded: 3 standalone VMs");
    } finally {
      newError = undefined;
    }
    await expect(p().connect("Not_A_Name")).rejects.toThrow(/invalid VM name/);
    await expect(p().connect("sbr-nope")).rejects.toMatchObject({ status: 404, message: "exedev: VM sbr-nope not found" });
    const sbx = await p().create({});
    await expect(sbx.exec(`echo ${"x".repeat(70_000)}`)).rejects.toThrow(/over the 64 KB \/exec limit/);
    await sbx.kill();
  });

  it("bakes the sandbox env into every command and runs it detached under timeout -k 5", async () => {
    const sbx = await p().create({ env: { BASE: "b" } });
    seen.length = 0;
    const r = await sbx.exec('printf "%s %s" "$BASE" "$X"', { env: { X: "y" }, cwd: root });
    expect(r).toMatchObject({ exitCode: 0, stdout: "b y", stderr: "" });
    const start = scripts()[0].script;
    expect(start).toMatch(/^d=\/tmp\/\.sbr-[0-9a-f]{16}; mkdir -p "\$d"/);
    expect(readdirSync(join(root, "vms", sbx.nativeId, "tmp"))).toEqual([]); // job dir removed once the result is read
    expect(start).toContain("setsid nohup bash -c 'timeout -k 5 60 bash");
    const b64 = /echo ([A-Za-z0-9+/=]+) \| base64 -d > "\$d\/cmd"/.exec(start)![1];
    expect(Buffer.from(b64, "base64").toString()).toBe(`cd '${root}' && export BASE='b' && export X='y' && {\nprintf "%s %s" "$BASE" "$X"\n}`);
    await expect(sbx.exec("sleep 4", { timeoutSeconds: 1 })).rejects.toThrow("exedev: command timed out after 1s");
    expect(scripts().at(-1)!.script).toContain("timeout -k 5 1 bash");
    await sbx.kill();
  });

  it("streams by polling once a second and keeps stdout and stderr apart", async () => {
    const sbx = await p().create({});
    seen.length = 0;
    const events: string[] = [];
    const r = await sbx.exec("echo one; sleep 1.3; echo two >&2; sleep 1.3; echo three; exit 4", {
      onStdout: (c) => events.push(`out:${c.trim()}`),
      onStderr: (c) => events.push(`err:${c.trim()}`),
    });
    expect(events).toEqual(["out:one", "err:two", "out:three"]);
    expect(r).toMatchObject({ exitCode: 4, stdout: "one\nthree\n", stderr: "two\n" });
    expect(scripts().length).toBeGreaterThanOrEqual(3);
    await sbx.kill();
  });

  it("moves files as base64 in 30 KB chunks under the body cap, then renames into place", async () => {
    const sbx = await p().create({});
    const big = new Uint8Array(70_000).map((_, i) => (i * 7) % 256);
    seen.length = 0;
    await sbx.writeFile(join(root, "deep", "big.bin"), big);
    const s = scripts().map((x) => x.script);
    expect(s).toHaveLength(4); // 3 chunks + mv
    expect(s[0]).toMatch(new RegExp(`^mkdir -p '${root}/deep' && echo [A-Za-z0-9+/=]+ \\| base64 -d > '${root}/deep/big.bin.sbr-[0-9a-f]{8}'$`));
    expect(s[1]).toMatch(/^echo [A-Za-z0-9+/=]+ \| base64 -d >> /);
    expect(s[3]).toMatch(new RegExp(`^mv -f '${root}/deep/big.bin.sbr-[0-9a-f]{8}' '${root}/deep/big.bin'$`));
    for (const r of seen) expect(Buffer.byteLength(r.command)).toBeLessThan(64 * 1024);
    expect(Buffer.from(await sbx.readFile(join(root, "deep", "big.bin"))).equals(Buffer.from(big))).toBe(true);
    await expect(sbx.readFile(join(root, "missing"))).rejects.toThrow(/readFile .*missing/);
    expect(sbx.pause).toBeUndefined();
    await sbx.kill();
  });
});
