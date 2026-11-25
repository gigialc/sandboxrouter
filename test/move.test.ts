import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Client } from "../src/client.js";
import { copyFiles } from "../src/move.js";
import { Router } from "../src/router.js";
import { createApp } from "../src/server.js";
import { RouterError, type ExecOptions, type ExecResult, type Provider, type ProviderId, type ProviderSandbox } from "../src/types.js";

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A sandbox that is a real folder on this machine, so tar and split really run. */
class LocalBox implements ProviderSandbox {
  readonly home = mkdtempSync(join(tmpdir(), "sr-box-"));
  killed = false;
  /** Cut every file read to this many bytes, like a provider that truncates. */
  truncateReads?: number;
  constructor(readonly nativeId: string) {
    made.push(this.home);
  }
  exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const started = Date.now();
    return new Promise((resolve) => {
      execFile("sh", ["-c", cmd], { cwd: opts.cwd ?? this.home, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ exitCode: code, stdout, stderr, durationMs: Date.now() - started });
      });
    });
  }
  async writeFile(path: string, content: string | Uint8Array) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  async readFile(path: string) {
    const data = new Uint8Array(readFileSync(path));
    return this.truncateReads === undefined ? data : data.slice(0, this.truncateReads);
  }
  async kill() {
    this.killed = true;
  }
}

class LocalProvider implements Provider {
  boxes: LocalBox[] = [];
  constructor(
    readonly id: ProviderId,
    private fail = false,
  ) {}
  configured() {
    return true;
  }
  async create() {
    if (this.fail) throw new Error("down");
    const box = new LocalBox(`${this.id}-${this.boxes.length + 1}`);
    this.boxes.push(box);
    return box;
  }
  async connect(id: string) {
    const box = this.boxes.find((b) => b.nativeId === id);
    if (!box) throw new Error(`no sandbox ${id}`);
    return box;
  }
}

function fill(home: string) {
  mkdirSync(join(home, "src/deep"), { recursive: true });
  mkdirSync(join(home, "node_modules/pkg"), { recursive: true });
  writeFileSync(join(home, "notes.txt"), "it's a \"quoted\" note\n");
  writeFileSync(join(home, "src/deep/data.bin"), Buffer.alloc(300_000, 7));
  writeFileSync(join(home, "run.sh"), "#!/bin/sh\necho hi\n");
  chmodSync(join(home, "run.sh"), 0o755);
  symlinkSync("notes.txt", join(home, "link"));
  writeFileSync(join(home, "node_modules/pkg/index.js"), "x");
  writeFileSync(join(home, ".bashrc"), "export FROM_SOURCE=1\n");
  writeFileSync(join(home, ".env"), "KEEP=1\n");
  writeFileSync(join(home, "src/.bashrc"), "nested\n");
}

const router = (...providers: Provider[]) => new Router({ providers, ledger: false, verified: [], failing: [], billedVsList: {} });

describe("copy and move between sandboxes", () => {
  it("copies a folder across providers in pieces: contents, modes and symlinks, minus what is excluded", async () => {
    const e2b = new LocalProvider("e2b");
    const daytona = new LocalProvider("daytona");
    const r = router(e2b, daytona);
    const a = await r.create({}, { provider: "e2b" });
    const b = await r.create({}, { provider: "daytona" });
    const [from, to] = [e2b.boxes[0], daytona.boxes[0]];
    fill(from.home);

    writeFileSync(join(to.home, ".bashrc"), "export FROM_IMAGE=1\n");
    // 64 KB pieces: the 300 KB file crosses in several.
    const result = await r.copy(a, b, { exclude: ["node_modules"], chunkBytes: 64 * 1024 });

    expect(result.from).toBe((await a.exec("pwd")).stdout.trim());
    expect(result.to).toBe((await b.exec("pwd")).stdout.trim());
    expect(result.bytes).toBeGreaterThan(0);
    expect(readFileSync(join(to.home, "notes.txt"), "utf8")).toBe("it's a \"quoted\" note\n");
    expect(readFileSync(join(to.home, "src/deep/data.bin")).equals(Buffer.alloc(300_000, 7))).toBe(true);
    expect(statSync(join(to.home, "run.sh")).mode & 0o111).toBe(0o111);
    expect(readFileSync(join(to.home, "link"), "utf8")).toBe("it's a \"quoted\" note\n");
    expect(existsSync(join(to.home, "node_modules"))).toBe(false);
    // The destination image's own shell startup file survives; other dotfiles and nested ones come across.
    expect(readFileSync(join(to.home, ".bashrc"), "utf8")).toBe("export FROM_IMAGE=1\n");
    expect(readFileSync(join(to.home, ".env"), "utf8")).toBe("KEEP=1\n");
    expect(existsSync(join(to.home, "src/.bashrc"))).toBe(true);
    // The source keeps its files and nothing is left in /tmp on either side.
    expect(existsSync(join(from.home, "node_modules/pkg/index.js"))).toBe(true);
    expect((await a.exec("ls -d /tmp/sr-move-* 2>/dev/null | wc -l")).stdout.trim()).toBe("0");
  });

  it("moves to another provider by default, keeps the size and kills the old sandbox", async () => {
    const maritime = new LocalProvider("maritime");
    const northflank = new LocalProvider("northflank");
    const r = router(maritime, northflank);
    const old = await r.create({}, { provider: "maritime" });
    fill(maritime.boxes[0].home);

    const next = await r.move(old);

    expect(next.provider).toBe("northflank");
    expect(next.size).toEqual(old.size);
    expect(await next.readText(join(northflank.boxes[0].home, "notes.txt"))).toContain("quoted");
    expect(next.moved.bytes).toBeGreaterThan(0);
    expect(maritime.boxes[0].killed).toBe(true);
    expect(northflank.boxes[0].killed).toBe(false);
  });

  it("leaves the old sandbox running when the copy fails, and kills the new one", async () => {
    const e2b = new LocalProvider("e2b");
    const daytona = new LocalProvider("daytona");
    const r = router(e2b, daytona);
    const old = await r.create({}, { provider: "e2b" });
    fill(e2b.boxes[0].home);
    e2b.boxes[0].truncateReads = 100;

    await expect(r.move(old)).rejects.toThrow(/arrived as 100 bytes on daytona/);
    expect(e2b.boxes[0].killed).toBe(false);
    expect(daytona.boxes[0].killed).toBe(true);
    expect(existsSync(join(daytona.boxes[0].home, "notes.txt"))).toBe(false);
  });

  it("refuses when there is nowhere else to go, a folder over the limit, or the whole filesystem", async () => {
    const e2b = new LocalProvider("e2b");
    const r = router(e2b);
    const old = await r.create({}, { provider: "e2b" });
    fill(e2b.boxes[0].home);

    await expect(r.move(old)).rejects.toMatchObject({ code: "no_provider" });
    const other = await r.create({}, { provider: "e2b" });
    await expect(copyFiles(old, other, { maxBytes: 10 })).rejects.toThrow(/over the 0\.0 MB limit/);
    await expect(copyFiles(old, other, { path: "/" })).rejects.toBeInstanceOf(RouterError);
    expect(e2b.boxes[0].killed).toBe(false);
  });

  it("with encrypt, relays only ciphertext, and the files still arrive intact", async () => {
    const e2b = new LocalProvider("e2b");
    const daytona = new LocalProvider("daytona");
    const r = router(e2b, daytona);
    const a = await r.create({}, { provider: "e2b" });
    const b = await r.create({}, { provider: "daytona" });
    const [from, to] = [e2b.boxes[0], daytona.boxes[0]];
    fill(from.home);
    writeFileSync(join(from.home, "secret.txt"), "SUBSCRIPTION-TOKEN-0123456789\n".repeat(200));

    // Everything that leaves the source sandbox on its way to the destination.
    const relayed: Buffer[] = [];
    const read = from.readFile.bind(from);
    from.readFile = async (path) => {
      const data = await read(path);
      relayed.push(Buffer.from(data));
      return data;
    };

    const result = await r.copy(a, b, { encrypt: true, chunkBytes: 64 * 1024 });

    expect(result.encrypted).toBe(true);
    const wire = Buffer.concat(relayed);
    expect(wire.length).toBeGreaterThan(1000);
    expect(wire.includes("SUBSCRIPTION-TOKEN")).toBe(false);
    // Not a gzip archive either: the plain archive would start with 1f 8b.
    expect(relayed.some((piece) => piece[0] === 0x1f && piece[1] === 0x8b)).toBe(false);
    expect(readFileSync(join(to.home, "secret.txt"), "utf8")).toContain("SUBSCRIPTION-TOKEN-0123456789");
    expect(readFileSync(join(to.home, "src/deep/data.bin")).equals(Buffer.alloc(300_000, 7))).toBe(true);
    expect(statSync(join(to.home, "run.sh")).mode & 0o111).toBe(0o111);
    // No key or archive is left behind on either side.
    expect((await a.exec("ls -d /tmp/sr-move-* 2>/dev/null | wc -l")).stdout.trim()).toBe("0");
  });

  it("with encrypt, refuses an archive that was changed on the way and unpacks nothing", async () => {
    const e2b = new LocalProvider("e2b");
    const daytona = new LocalProvider("daytona");
    const r = router(e2b, daytona);
    const a = await r.create({}, { provider: "e2b" });
    const b = await r.create({}, { provider: "daytona" });
    const [from, to] = [e2b.boxes[0], daytona.boxes[0]];
    fill(from.home);

    const read = from.readFile.bind(from);
    from.readFile = async (path) => {
      const data = Buffer.from(await read(path));
      // Flip one byte in the middle of an archive piece, as something in between could.
      if (/\/p\.[a-z]{4}$/.test(path)) data[Math.floor(data.length / 2)] ^= 0xff;
      return new Uint8Array(data);
    };

    await expect(r.copy(a, b, { encrypt: true })).rejects.toThrow(/decrypting and unpacking the folder failed on daytona/);
    expect(existsSync(join(to.home, "notes.txt"))).toBe(false);
    expect(existsSync(join(from.home, "notes.txt"))).toBe(true);
  });

  it("moves through the HTTP API with the hosted client", async () => {
    const e2b = new LocalProvider("e2b");
    const daytona = new LocalProvider("daytona");
    const server: Server = createApp(router(e2b, daytona), "tok");
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const sr = new Client({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, apiKey: "tok" });
      const old = await sr.create({}, { provider: "e2b" });
      fill(e2b.boxes[0].home);

      const next = await sr.move(old, { exclude: ["node_modules"] });

      expect(next.provider).toBe("daytona");
      expect(readFileSync(join(daytona.boxes[0].home, "src/deep/data.bin")).length).toBe(300_000);
      expect(existsSync(join(daytona.boxes[0].home, "node_modules"))).toBe(false);
      expect(e2b.boxes[0].killed).toBe(true);
    } finally {
      server.close();
    }
  });
});
