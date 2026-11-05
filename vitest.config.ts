import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Routers keep a ledger of created sandboxes; keep the tests' ledger out of ~/.sandboxrouter.
    env: { SANDBOXROUTER_HOME: mkdtempSync(join(tmpdir(), "sbr-test-")) },
  },
});
