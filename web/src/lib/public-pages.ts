import type { Metadata } from "next";
import { site } from "@/lib/site";

export const ORIGIN = "https://www.sandboxrouter.ai";
export const MARKDOWN = "text/markdown";

export const publicPages = [
  { path: "/", title: "SandboxRouter", description: "Open-source sandbox routing, SDK quickstart, and hosted API overview." },
  { path: "/benchmarks", title: "Benchmarks", description: "Estimated costs, measured workloads, start times, bursts, and billing evidence." },
  { path: "/methodology", title: "Methodology", description: "How each benchmark and price is calculated." },
  { path: "/providers", title: "Providers", description: "Sandbox, desktop, and phone prices and capabilities." },
  { path: "/docs", title: "API, SDK, and CLI documentation", description: "Installation, routing, HTTP APIs, and examples." },
  { path: "/learn", title: "Learn", description: "What sandboxes do and how AI agents use them." },
  { path: "/security", title: "Security", description: "Where code, credentials, and hosted data live." },
  { path: "/playground", title: "Playground", description: "Connect to a SandboxRouter server you run." },
  ...site.providers.map((p) => ({ path: `/providers/${p.id}`, title: p.name, description: "Pricing, capabilities, setup, and test results." })),
];

export const markdownPath = (path: string) => path === "/" ? "/index.md" : `${path}.md`;

export function pageAlternates(path: string): Metadata["alternates"] {
  return { canonical: path, types: { [MARKDOWN]: markdownPath(path) } };
}
