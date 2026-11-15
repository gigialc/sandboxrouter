import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher, type Dispatcher } from "undici";
import { CATALOG } from "../src/catalog.js";
import { KEYED_PROVIDERS, providerWithKey } from "../src/keyed.js";

/**
 * A service that runs sandboxes on its own accounts lets users bring their own key for these providers.
 * If an adapter ever sent the service's key (from the environment) instead of the one it was given, the
 * user's sandbox would start on the service's account. Every request each adapter makes on create must
 * carry the key it was given and never the one in the environment.
 *
 * Requests are caught at the bottom: fetch (and SDKs that kept a reference to it) through undici's global
 * dispatcher, and SDKs on node:http (Daytona's axios) through a local server their base URL points at.
 */
describe("providerWithKey", () => {
  const seen: string[] = [];
  const record = (url: string, headers: unknown, body: unknown) =>
    seen.push(`${url} ${JSON.stringify(headers)} ${typeof body === "string" ? body : ""}`);
  let previous: Dispatcher;
  let server: Server;
  let local = "";

  beforeAll(async () => {
    previous = getGlobalDispatcher();
    const agent = new MockAgent();
    agent.disableNetConnect();
    agent.enableNetConnect(/^127\.0\.0\.1/);
    agent
      .get(() => true)
      .intercept({ path: () => true, method: () => true })
      .reply(401, (opts) => {
        record(`${opts.origin}${opts.path}`, opts.headers, opts.body);
        return { error: "stop here" };
      })
      .persist();
    setGlobalDispatcher(agent);
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        record(`local${req.url}`, req.headers, body);
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "stop here" }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const a = server.address();
    local = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  });

  afterAll(async () => {
    setGlobalDispatcher(previous);
    await new Promise((r) => server.close(r));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    seen.length = 0;
  });

  for (const id of KEYED_PROVIDERS) {
    it(`${id}: create sends the given key, never the environment's`, async (ctx) => {
      for (const v of CATALOG.find((c) => c.id === id)!.credentials.flat()) vi.stubEnv(v, `OURS-${id}-0123456789abcdef0123456789abcdef`);
      // SDKs with their own HTTP client (Daytona: axios; E2B and OpenScale: e2b's own undici; Tensorlake) go to the local server.
      const base: Partial<Record<string, string>> = { daytona: "DAYTONA_API_URL", e2b: "E2B_API_URL", openscale: "OPENSCALE_API_URL", tensorlake: "TENSORLAKE_API_URL" };
      if (base[id]) vi.stubEnv(base[id]!, local);
      // Other credentials those SDKs would read from the environment if given the chance.
      for (const v of ["TENSORLAKE_PAT", "DAYTONA_JWT_TOKEN"]) vi.stubEnv(v, `OURS-${v}`);
      // E2B's SDK refuses a key without its prefix before sending anything.
      const theirs = `${id === "e2b" || id === "openscale" ? "e2b_" : ""}THEIRS-${id}-0123456789abcdef0123456789abcdef`;
      const p = providerWithKey(id, theirs);
      expect(p.configured()).toBe(true);
      const missing = await p.create({ vcpu: 2, memoryGb: 4, timeoutMinutes: 5 }).then(
        (s) => void s.kill().catch(() => {}),
        (err: Error) => /needs the "[^"]+" package/.test(err.message),
      );
      // An optional vendor package not installed here (Novita's in CI): nothing to check. Hosted installs it.
      if (missing && seen.length === 0) return ctx.skip();
      const all = seen.join("\n");
      expect(all).not.toContain("OURS-");
      expect(seen.length, `${id} made no request this test could see, so its key can't be checked`).toBeGreaterThan(0);
      expect(all.includes(theirs) || all.includes(Buffer.from(theirs).toString("base64"))).toBe(true);
    });
  }

  it("refuses an empty key and providers it can't keep apart", () => {
    expect(() => providerWithKey("e2b", "  ")).toThrow(/empty/);
    expect(() => providerWithKey("modal", "x")).toThrow(/can't take a key/);
  });
});
