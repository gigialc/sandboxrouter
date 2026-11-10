import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // hosted/ has its own dependencies and runs its own tests (CI: the Hosted API step).
    exclude: [...configDefaults.exclude, "hosted/**", "web/**"],
    // Routers keep a ledger of created sandboxes; keep the tests' ledger out of ~/.sandboxrouter.
    env: { SANDBOXROUTER_HOME: mkdtempSync(join(tmpdir(), "sbr-test-")) },
  },
});
