import { randomUUID } from "node:crypto";
import { RouterError, type ExecOptions, type ExecResult, type ProviderId, type RouteOptions, type SandboxSpec } from "./types.js";
import { shq } from "./util.js";

/** What copy and move need from a sandbox: a `RoutedSandbox` and a `RemoteSandbox` both fit. */
export interface FileBox {
  readonly id: string;
  readonly provider: string;
  readonly size?: { vcpu: number; memoryGb: number };
  exec(cmd: string, opts?: ExecOptions): Promise<ExecResult>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  kill(): Promise<void>;
}

export interface CopyOptions {
  /**
   * Folder to copy from the source. Default: the folder its commands run in. Copied whole like that,
   * the destination keeps its own shell startup files (`.bashrc`, `.profile`, ...), since those belong to its image.
   */
  path?: string;
  /** Folder to copy into. Default: the same path, or the destination's own working folder when `path` isn't given. */
  to?: string;
  /** Names or patterns to leave behind, as `tar --exclude` reads them, e.g. `["node_modules", ".venv", "*.log"]`. */
  exclude?: string[];
  /** Refuse when the packed folder is bigger than this (default 1 GB), before anything is sent. */
  maxBytes?: number;
  /** Seconds each pack and unpack command may take (default 600). */
  timeoutSeconds?: number;
  /** Bytes sent per file transfer (default 4 MB). Providers cap how much one file call carries. */
  chunkBytes?: number;
}

export interface CopyResult {
  /** The folder read on the source. */
  from: string;
  /** The folder written on the destination. */
  to: string;
  /** Size of the packed (gzip) folder that was sent. */
  bytes: number;
  ms: number;
}

export interface MoveOptions extends CopyOptions, RouteOptions {
  /** The new sandbox's spec. Its size defaults to the old sandbox's. */
  spec?: SandboxSpec;
  /** Leave the old sandbox running (default: kill it once the files are across). */
  keep?: boolean;
}

export const DEFAULT_COPY_MAX_BYTES = 1024 ** 3;
/** Shell startup files the destination keeps as its image made them when a working folder is copied whole (no `path`). */
const IMAGE_FILES = [".bashrc", ".bash_profile", ".bash_logout", ".profile", ".zshrc"];
const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;
const DEFAULT_COPY_TIMEOUT_S = 600;

/**
 * Copy a folder from one sandbox to another, on any two providers: packed with tar on the source,
 * carried through this process in pieces, unpacked on the destination. Files, their modes and
 * symlinks come across; running processes, memory and env vars don't. The source isn't changed.
 * Both sandboxes need `tar` and `split` (every stock image has them).
 */
export async function copyFiles(from: FileBox, to: FileBox, opts: CopyOptions = {}): Promise<CopyResult> {
  const started = Date.now();
  const timeoutSeconds = opts.timeoutSeconds ?? DEFAULT_COPY_TIMEOUT_S;
  const chunk = Math.max(64 * 1024, Math.floor(opts.chunkBytes ?? DEFAULT_CHUNK_BYTES));
  const maxBytes = opts.maxBytes ?? DEFAULT_COPY_MAX_BYTES;
  const src = opts.path ?? (await workdir(from));
  const dst = opts.to ?? opts.path ?? (await workdir(to));
  for (const p of [src, dst]) {
    if (!p.startsWith("/")) throw new RouterError(`copy needs an absolute path, got "${p}"`, [], "bad_request");
    if (p.replace(/\/+$/, "") === "") throw new RouterError("copy won't take the whole filesystem (/): name a folder", [], "bad_request");
  }

  const tmp = `/tmp/sr-move-${randomUUID().slice(0, 8)}`;
  const run = async (box: FileBox, what: string, cmd: string) => {
    const r = await box.exec(cmd, { timeoutSeconds });
    if (r.exitCode !== 0) {
      const detail = (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ");
      throw new RouterError(`${what} failed on ${box.provider} (exit ${r.exitCode})${detail ? `: ${detail}` : ""}`, [], "all_failed");
    }
    return r.stdout;
  };
  const clean = (box: FileBox) => box.exec(`rm -rf ${shq(tmp)}`, { timeoutSeconds: 60 }).catch(() => {});

  try {
    // The archive is written outside the folder where it can be, and excluded by name in case /tmp is inside it.
    const excludes = ["sr-move-*", ...(opts.exclude ?? [])].map((e) => `--exclude=${shq(e)}`).join(" ");
    const packed = await run(
      from,
      "packing the folder",
      [
        `mkdir -p ${shq(tmp)}`,
        `tar -czf ${shq(`${tmp}/a.tgz`)} ${excludes} -C ${shq(src)} .`,
        `echo "size=$(wc -c < ${shq(`${tmp}/a.tgz`)} | tr -d ' ')"`,
      ].join(" && "),
    );
    const bytes = Number(/size=(\d+)/.exec(packed)?.[1] ?? NaN);
    if (!Number.isFinite(bytes)) throw new RouterError(`couldn't read the packed size on ${from.provider}`, [], "all_failed");
    if (bytes > maxBytes) {
      throw new RouterError(`the folder packs to ${mb(bytes)}, over the ${mb(maxBytes)} limit: pass exclude (e.g. node_modules) or a higher maxBytes`, [], "bad_request");
    }

    const listed = await run(from, "splitting the archive", `cd ${shq(tmp)} && split -b ${chunk} -a 4 a.tgz p. && rm a.tgz && ls p.*`);
    const parts = listed.split("\n").map((l) => l.trim()).filter((l) => /^p\.[a-z]{4}$/.test(l)).sort();
    if (parts.length === 0) throw new RouterError(`no archive pieces found on ${from.provider}`, [], "all_failed");

    await run(to, "preparing the destination", `mkdir -p ${shq(tmp)} ${shq(dst)}`);
    for (const part of parts) await to.writeFile(`${tmp}/${part}`, await from.readFile(`${tmp}/${part}`));

    // The size check catches a piece a provider cut short before tar unpacks half a folder.
    const got = await run(to, "checking the archive", `cat ${shq(tmp)}/p.* | wc -c | tr -d ' '`);
    if (Number(got.trim().split("\n").pop()) !== bytes) {
      throw new RouterError(`the archive arrived as ${got.trim()} bytes on ${to.provider}, expected ${bytes}`, [], "all_failed");
    }
    // -o: the files belong to whoever runs the destination sandbox, not the source's user id.
    // Copying a whole working folder would replace the destination image's shell startup files with
    // the source image's (a different PATH, a different user): the destination's are put back after.
    const keep = opts.path === undefined ? IMAGE_FILES.map(shq).join(" ") : "";
    const save = keep ? `mkdir -p ${shq(`${tmp}/keep`)} && for f in ${keep}; do if [ -f ${shq(dst)}/"$f" ]; then cp -p ${shq(dst)}/"$f" ${shq(`${tmp}/keep`)}/; fi; done && ` : "";
    const restore = keep ? ` && for f in ${keep}; do if [ -f ${shq(`${tmp}/keep`)}/"$f" ]; then cp -p ${shq(`${tmp}/keep`)}/"$f" ${shq(dst)}/; fi; done` : "";
    await run(to, "unpacking the folder", `${save}cat ${shq(tmp)}/p.* | tar -xzo -f - -C ${shq(dst)}${restore}`);
    return { from: src, to: dst, bytes, ms: Date.now() - started };
  } finally {
    await Promise.all([clean(from), clean(to)]);
  }
}

/** What a move needs from a router: a `Router` and a hosted `Client` both fit. */
export interface Mover<B extends FileBox> {
  candidates(spec: SandboxSpec, route: RouteOptions): Promise<{ provider: ProviderId; skip?: string }[]>;
  create(spec: SandboxSpec, route: RouteOptions): Promise<B>;
}

/**
 * Start a sandbox on another provider, copy the folder across, then kill the old one. If anything
 * fails the new sandbox is killed and the old one is left as it was.
 */
export async function moveSandbox<B extends FileBox>(mover: Mover<B>, from: FileBox, opts: MoveOptions = {}): Promise<B & { moved: CopyResult }> {
  const { spec: given = {}, keep, path, to, exclude, maxBytes, timeoutSeconds, chunkBytes, ...route } = opts;
  let spec: SandboxSpec = { ...given };
  const elsewhere = async (s: SandboxSpec) =>
    (await mover.candidates(s, route)).filter((c) => !c.skip && c.provider !== from.provider).map((c) => c.provider);
  // The new sandbox keeps the old one's size. A provider's fixed default size (E2B's 2 vCPU / 0.5 GB)
  // may be one nobody else sells, so when nothing else takes it the move goes ahead at the default size.
  const sized = given.vcpu === undefined && given.memoryGb === undefined && from.size ? { ...given, vcpu: from.size.vcpu, memoryGb: from.size.memoryGb } : undefined;
  if (route.provider !== undefined) {
    if (sized && (await mover.candidates(sized, route)).some((c) => !c.skip)) spec = sized;
  } else {
    // Without a named provider, "move" means somewhere else: the usual order, minus where it is now.
    let list = sized ? await elsewhere(sized) : [];
    if (list.length > 0) spec = sized!;
    else list = await elsewhere(spec);
    if (list.length === 0) throw new RouterError(`no other provider can take this sandbox (it is on ${from.provider})`, [], "no_provider");
    route.provider = list;
  }
  const next = await mover.create(spec, route);
  let moved: CopyResult;
  try {
    moved = await copyFiles(from, next, { path, to, exclude, maxBytes, timeoutSeconds, chunkBytes });
  } catch (error) {
    await next.kill().catch(() => {});
    throw error;
  }
  if (!keep) await from.kill();
  return Object.assign(next, { moved });
}

async function workdir(box: FileBox): Promise<string> {
  const r = await box.exec("pwd", { timeoutSeconds: 60 });
  const dir = r.stdout.trim().split("\n").pop()?.trim() ?? "";
  if (r.exitCode !== 0 || !dir.startsWith("/")) throw new RouterError(`couldn't find the working folder on ${box.provider}: pass path`, [], "all_failed");
  return dir;
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
