// Starts the HTTP API with in-memory providers for the Python client's tests. Prints the port.
import { Router } from "../src/router.js";
import { createApp } from "../src/server.js";
import { ALL, FakeProvider } from "./fake.js";

const providers = ALL.map((id) => new FakeProvider(id, id === "maritime" ? { fail: "429 concurrency_limit" } : {}));
// Cooldowns off: these tests check the exact order providers are tried in, request after request.
const app = createApp(new Router({ providers, ledger: false, failing: [], cooldown: false }), "pytok");
app.listen(0, "127.0.0.1", () => {
  console.log(`PORT=${(app.address() as { port: number }).port}`);
});
