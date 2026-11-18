import { randomUUID } from "node:crypto";
import { ProviderError, type ExecResult, type ProviderId } from "../types.js";
import { shq, toBytes } from "../util.js";

type ShellExec = (command: string) => Promise<ExecResult>;

/** Binary-safe files for shell APIs whose command arguments and output have bounded sizes. */
export class ShellFiles {
  constructor(private provider: ProviderId, private run: ShellExec) {}

  private async checked(command: string): Promise<string> {
    const result = await this.run(command);
    if (result.exitCode !== 0) throw new ProviderError(this.provider, result.stderr.trim() || "sandbox file command failed");
    return result.stdout;
  }

  async writeFile(path: string, content: Uint8Array | string): Promise<void> {
    const destination = shq(path);
    const temporary = shq(`${path}.sbr-${randomUUID()}`);
    const bytes = Buffer.from(toBytes(content));
    const chunkSize = 32 * 1024;

    await this.checked(`mkdir -p -- "$(dirname -- ${destination})" && umask 077 && : > ${temporary}`);
    try {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const chunk = bytes.subarray(offset, offset + chunkSize).toString("base64");
        await this.checked(`printf '%s' '${chunk}' | base64 -d >> ${temporary}`);
      }
      await this.checked(`mv -f -- ${temporary} ${destination}`);
    } catch (err) {
      await this.run(`rm -f -- ${temporary}`).catch(() => {});
      throw err;
    }
  }

  async readFile(path: string): Promise<Uint8Array> {
    const source = shq(path);
    const length = Number((await this.checked(`test -f ${source} && wc -c < ${source}`)).trim());
    if (!Number.isSafeInteger(length) || length < 0) throw new ProviderError(this.provider, "invalid sandbox file length");

    const chunks: Buffer[] = [];
    const chunkSize = 128 * 1024;
    for (let offset = 0; offset < length; offset += chunkSize) {
      const read = await this.checked(`bash -o pipefail -c ${shq(`dd if=${source} bs=${chunkSize} skip=${offset / chunkSize} count=1 2>/dev/null | base64`)}`);
      const chunk = Buffer.from(read, "base64");
      if (chunk.length !== Math.min(chunkSize, length - offset)) throw new ProviderError(this.provider, "sandbox file changed or the response was truncated");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
}
