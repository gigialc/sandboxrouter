/** Single-quote a string for POSIX sh. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Build `cd dir && VAR=x cmd` for providers whose exec API lacks cwd/env. */
export function wrapCommand(cmd: string, opts: { cwd?: string; env?: Record<string, string> } = {}): string {
  const parts: string[] = [];
  if (opts.cwd) parts.push(`cd ${shq(opts.cwd)} &&`);
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`invalid env var name: ${k}`);
    parts.push(`export ${k}=${shq(v)};`);
  }
  parts.push(cmd);
  return parts.join(" ");
}

export function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

/** Load an optional peer dependency with a helpful error. */
export async function optionalImport<T>(pkg: string, provider: string): Promise<T> {
  try {
    return (await import(pkg)) as T;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Bundlers and test runners (Vite, esbuild) report a missing package without Node's error code.
    const missing = /Cannot find (module|package)|Could not resolve|Failed to (resolve|load url)/.test(String((err as Error)?.message));
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND" || missing) {
      throw new Error(`${provider} needs the "${pkg}" package: npm i ${pkg}`);
    }
    throw err;
  }
}
