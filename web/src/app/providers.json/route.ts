import { providersJson } from "@/lib/agents";

export function GET() {
  return Response.json(providersJson(), {
    headers: { "access-control-allow-origin": "*", "cache-control": "public, max-age=3600" },
  });
}
