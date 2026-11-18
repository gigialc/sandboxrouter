import spec from "@/data/openapi.json";

export function GET() {
  return Response.json(spec, {
    headers: { "access-control-allow-origin": "*", "cache-control": "public, max-age=3600" },
  });
}
