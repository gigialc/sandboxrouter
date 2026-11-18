import { ORIGIN } from "@/lib/public-pages";

export function GET() {
  return Response.json({
    linkset: [{
      anchor: ORIGIN,
      "service-desc": [{ href: `${ORIGIN}/openapi.json`, type: "application/json" }],
      "service-doc": [{ href: `${ORIGIN}/docs#agents`, type: "text/html" }],
    }],
  }, {
    headers: {
      "content-type": "application/linkset+json",
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=3600",
    },
  });
}
