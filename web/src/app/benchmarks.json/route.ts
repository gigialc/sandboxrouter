import { benchmarksJson } from "@/lib/agents";

// The published benchmark numbers for agents and scripts. Static: rebuilt with the site when results change.
export function GET() {
  return Response.json(benchmarksJson(), {
    headers: { "access-control-allow-origin": "*", "cache-control": "public, max-age=3600" },
  });
}
