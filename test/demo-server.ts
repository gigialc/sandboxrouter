// Local demo server with in-memory providers, for trying the website's Playground without keys.
// Nothing real is started. Run: node --import tsx test/demo-server.ts
import { Router } from "../src/router.js";
import { createApp } from "../src/server.js";
import { ALL, FakeProvider } from "./fake.js";

const providers = ALL.map((id) => new FakeProvider(id, id === "maritime" ? { fail: "429 concurrency_limit (demo)" } : {}));
const app = createApp(new Router({ providers, ledger: false }), "demo", ["http://localhost:3000", "https://www.sandboxrouter.ai", "https://sandboxrouter.ai", "https://sandboxrouter.vercel.app"]);
app.listen(8787, "127.0.0.1", () => console.log("demo server on http://127.0.0.1:8787, token: demo"));
