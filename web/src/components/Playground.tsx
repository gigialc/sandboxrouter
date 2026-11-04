"use client";

import { useEffect, useRef, useState } from "react";
import { CodeBlock } from "@/components/code";
import { shapeLabel, site, usd } from "@/lib/site";

type Attempt = { provider: string; ok: boolean; ms: number; error?: string };
type Sbx = { id: string; provider: string; estimatedHourlyUsd: number; attempts: Attempt[] };
type Line = { stream: "out" | "err" | "sys"; text: string };

const STORE = "sandboxrouter.playground";

async function* sse(res: Response) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let event = "message";
  let data: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    buf += done ? "\n\n" : dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line === "") {
        if (data.length) yield { event, data: data.join("\n") };
        event = "message";
        data = [];
      } else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (done) return;
  }
}

export function Playground() {
  const [url, setUrl] = useState("http://127.0.0.1:8787");
  const [token, setToken] = useState("");
  const [origin, setOrigin] = useState("http://localhost:3000");
  const [configured, setConfigured] = useState<string[] | null>(null);
  const [connErr, setConnErr] = useState<string | null>(null);
  const [provider, setProvider] = useState("auto");
  const [strategy, setStrategy] = useState("cheapest");
  const [shape, setShape] = useState("2x4");
  const [sbx, setSbx] = useState<Sbx | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [cmd, setCmd] = useState(`for i in 1 2 3; do echo "step $i"; sleep 0.5; done; python3 -c "print(6*7)"`);
  const [lines, setLines] = useState<Line[]>([]);
  const term = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setOrigin(window.location.origin);
    try {
      const s = JSON.parse(localStorage.getItem(STORE) ?? "{}");
      if (s.url) setUrl(s.url);
      if (s.token) setToken(s.token);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    term.current?.scrollTo({ top: term.current.scrollHeight });
  }, [lines]);

  const api = (path: string, init: RequestInit = {}) =>
    fetch(url.replace(/\/$/, "") + path, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers },
    });

  const say = (l: Line) => setLines((xs) => [...xs, l]);

  async function connect() {
    setBusy("connect");
    setConnErr(null);
    localStorage.setItem(STORE, JSON.stringify({ url, token }));
    try {
      const res = await api("/v1/providers");
      if (res.status === 401) throw new Error("The token doesn't match SANDBOXROUTER_TOKEN on the server.");
      if (!res.ok) throw new Error(`Server answered ${res.status}.`);
      const { providers } = await res.json();
      setConfigured(providers.filter((p: { configured: boolean }) => p.configured).map((p: { id: string }) => p.id));
    } catch (e) {
      setConfigured(null);
      setConnErr(
        e instanceof TypeError
          ? "Couldn't reach the server. Is it running, and was it started with --cors for this site?"
          : (e as Error).message,
      );
    } finally {
      setBusy(null);
    }
  }

  async function start() {
    setBusy("start");
    setLines([]);
    const [vcpu, memoryGb] = shape.split("x").map(Number);
    const body: Record<string, unknown> = { vcpu, memoryGb, timeoutMinutes: 10 };
    if (provider !== "auto") body.provider = provider;
    if (strategy !== "default") body.strategy = strategy;
    try {
      const res = await api("/v1/sandboxes", { method: "POST", body: JSON.stringify(body) });
      const j = await res.json();
      if (!res.ok) {
        say({ stream: "sys", text: `Couldn't start a sandbox: ${j.error}` });
        return;
      }
      setSbx(j);
      say({ stream: "sys", text: `Started ${j.id} on ${j.provider}` });
    } catch (e) {
      say({ stream: "sys", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function run() {
    if (!sbx) return;
    setBusy("run");
    say({ stream: "sys", text: `$ ${cmd}` });
    try {
      const res = await api(`/v1/sandboxes/${encodeURIComponent(sbx.id)}/exec`, {
        method: "POST",
        headers: { Accept: "text/event-stream" },
        body: JSON.stringify({ cmd, stream: true, timeoutSeconds: 120 }),
      });
      if (!res.ok) {
        say({ stream: "sys", text: `Error ${res.status}: ${(await res.json()).error}` });
        return;
      }
      for await (const ev of sse(res)) {
        const payload = JSON.parse(ev.data);
        if (ev.event === "stdout") say({ stream: "out", text: payload });
        else if (ev.event === "stderr") say({ stream: "err", text: payload });
        else if (ev.event === "result") say({ stream: "sys", text: `exit ${payload.exitCode} · ${payload.durationMs} ms` });
        else if (ev.event === "error") say({ stream: "sys", text: `Error: ${payload.error}` });
      }
    } catch (e) {
      say({ stream: "sys", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function kill() {
    if (!sbx) return;
    setBusy("kill");
    await api(`/v1/sandboxes/${encodeURIComponent(sbx.id)}`, { method: "DELETE" }).catch(() => {});
    say({ stream: "sys", text: `Killed ${sbx.id}` });
    setSbx(null);
    setBusy(null);
  }

  const field = "w-full border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-line-2";

  return (
    <div className="mx-auto grid max-w-5xl gap-6 px-6 lg:grid-cols-[20rem_1fr]">
      <div className="space-y-6">
        <section className="border border-line p-5">
          <h2 className="font-normal">1. Connect your server</h2>
          <p className="mt-1 text-sm text-muted">Your keys stay on your machine. This page only talks to the server you run.</p>
          <label className="mt-4 block text-xs text-muted">
            Server URL
            <input value={url} onChange={(e) => setUrl(e.target.value)} className={`${field} mt-1 font-mono`} />
          </label>
          <label className="mt-3 block text-xs text-muted">
            Token
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="SANDBOXROUTER_TOKEN"
              className={`${field} mt-1 font-mono`}
            />
          </label>
          <button
            onClick={connect}
            disabled={busy !== null}
            className="mt-4 w-full border border-line-2 px-4 py-2 text-sm font-medium hover:bg-panel-2 disabled:opacity-40"
          >
            {busy === "connect" ? "Connecting…" : configured ? "Reconnect" : "Connect"}
          </button>
          {connErr && <p className="mt-3 text-sm text-bad">{connErr}</p>}
          {configured && (
            <p className="mt-3 text-sm text-ok">
              Connected · {configured.length ? `keys for ${configured.join(", ")}` : "no provider keys set on the server yet"}
            </p>
          )}
        </section>

        <section className={` border border-line p-5 ${configured ? "" : "opacity-50"}`}>
          <h2 className="font-normal">2. Start a sandbox</h2>
          <label className="mt-4 block text-xs text-muted">
            Provider
            <select value={provider} onChange={(e) => setProvider(e.target.value)} className={`${field} mt-1`} disabled={!configured}>
              <option value="auto">Let the router choose</option>
              {site.providers
                .filter((p) => configured?.includes(p.id))
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <label className="block text-xs text-muted">
              Strategy
              <select value={strategy} onChange={(e) => setStrategy(e.target.value)} className={`${field} mt-1`} disabled={!configured || provider !== "auto"}>
                                <option value="cheapest">cheapest</option>
                <option value="fastest">fastest</option>
              </select>
            </label>
            <label className="block text-xs text-muted">
              Machine
              <select value={shape} onChange={(e) => setShape(e.target.value)} className={`${field} mt-1`} disabled={!configured}>
                {site.shapes.slice(0, 4).map((s) => (
                  <option key={s} value={s}>
                    {shapeLabel(s)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button
            onClick={start}
            disabled={!configured || busy !== null || !!sbx}
            className="mt-4 w-full bg-ink px-4 py-2 text-sm font-medium text-bg disabled:opacity-40"
          >
            {busy === "start" ? "Starting…" : "Start sandbox"}
          </button>

          {sbx && (
            <div className="mt-4 border border-line bg-bg p-3 text-sm">
              <div className="font-mono text-xs break-all">{sbx.id}</div>
              <div className="mt-1 text-ink-2">
                on <b>{sbx.provider}</b> · ~{usd(sbx.estimatedHourlyUsd)}/hr
              </div>
              <ul className="mt-2 space-y-1 font-mono text-xs">
                {sbx.attempts.map((a, k) => (
                  <li key={k} className={a.ok ? "text-ok" : "text-bad"}>
                    {a.ok ? "✓" : "✗"} {a.provider} · {a.ms} ms{a.error ? ` · ${a.error.slice(0, 80)}` : ""}
                  </li>
                ))}
              </ul>
              <button onClick={kill} disabled={busy !== null} className="mt-3 text-xs text-bad underline underline-offset-2">
                Kill sandbox
              </button>
            </div>
          )}
        </section>
      </div>

      <section className="flex min-h-[32rem] flex-col overflow-hidden border border-line bg-panel">
        <div className="flex items-center gap-2 border-b border-white/10 p-3">
          <input
            value={cmd}
            onChange={(e) => setCmd(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && sbx && !busy && run()}
            aria-label="Command"
            className="flex-1 border border-white/10 bg-white/5 px-3 py-2 font-mono text-sm text-ink-2 outline-none"
          />
          <button
            onClick={run}
            disabled={!sbx || busy !== null}
            className="bg-ink px-4 py-2 text-sm font-medium text-bg disabled:opacity-40"
          >
            {busy === "run" ? "Running…" : "Run"}
          </button>
        </div>
        <div ref={term} className="flex-1 overflow-auto p-4 font-mono text-[13px] leading-6 whitespace-pre-wrap">
          {lines.length === 0 ? (
            <div className="text-muted">
              {configured ? "Start a sandbox, then run a command. Output streams here as it happens." : "Connect to your server to begin."}
            </div>
          ) : (
            lines.map((l, k) => (
              <span
                key={k}
                className={l.stream === "err" ? "text-[#ff8a7a]" : l.stream === "sys" ? "block text-muted" : "text-ink-2"}
              >
                {l.text}
                {l.stream === "sys" ? "\n" : ""}
              </span>
            ))
          )}
        </div>
      </section>

      <section className="lg:col-span-2">
        <h2 className="font-normal">Don&apos;t have a server running?</h2>
        <p className="mt-1 text-sm text-muted">Run this in a terminal with at least one provider key, then press Connect.</p>
        <div className="mt-3">
          <CodeBlock
            title="terminal"
            code={`export E2B_API_KEY=...            # any provider's key works
export SANDBOXROUTER_TOKEN=pick-a-secret
npx @sandboxrouter/sdk serve --cors ${origin}`}
          />
        </div>
      </section>
    </div>
  );
}
