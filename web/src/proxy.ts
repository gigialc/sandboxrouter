import { NextResponse, type NextRequest } from "next/server";

// Agents get Markdown: `/<page>.md`, or any page with `Accept: text/markdown` (and no stronger preference for HTML).
export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname.startsWith("/md/") || pathname === "/md") return NextResponse.next();
  const url = req.nextUrl.clone();
  if (pathname.endsWith(".md")) {
    url.pathname = `/md${pathname === "/index.md" ? "" : pathname.slice(0, -3)}`;
    return NextResponse.rewrite(url);
  }
  const accept = req.headers.get("accept") ?? "";
  if (/text\/markdown/i.test(accept) && !/text\/html/i.test(accept)) {
    url.pathname = `/md${pathname === "/" ? "" : pathname}`;
    return NextResponse.rewrite(url);
  }
  return NextResponse.next();
}

export const config = {
  // Pages only: not assets, API-like files, or the MCP endpoint.
  matcher: ["/((?!_next/|mcp|llms\\.txt|benchmarks\\.json|sitemap\\.xml|robots\\.txt|icon|opengraph-image|twitter-image|favicon).*)"],
};
