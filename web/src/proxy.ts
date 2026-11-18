import { NextResponse, type NextRequest } from "next/server";

function prefersMarkdown(accept: string) {
  let markdown = -1;
  let html = -1;
  for (const value of accept.split(",")) {
    const [type, ...params] = value.trim().toLowerCase().split(";");
    const q = params.find((p) => p.trim().startsWith("q="));
    const quality = q === undefined ? 1 : Number(q.trim().slice(2));
    if (!(quality >= 0 && quality <= 1)) continue;
    if (type.trim() === "text/markdown") markdown = Math.max(markdown, quality);
    if (type.trim() === "text/html") html = Math.max(html, quality);
  }
  return markdown > 0 && markdown > html;
}

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (!["GET", "HEAD"].includes(req.method) || req.headers.has("rsc")) return NextResponse.next();
  if (pathname.startsWith("/md/") || pathname === "/md") return NextResponse.next();

  const url = req.nextUrl.clone();
  if (pathname.endsWith(".md")) {
    url.pathname = `/md${pathname === "/index.md" ? "" : pathname.slice(0, -3)}`;
    return NextResponse.rewrite(url);
  }
  if (pathname.startsWith("/.") || /\.[^/]+$/.test(pathname)) return NextResponse.next();

  const response = prefersMarkdown(req.headers.get("accept") ?? "")
    ? NextResponse.rewrite(new URL(`/md${pathname === "/" ? "" : pathname}${url.search}`, url))
    : NextResponse.next();
  response.headers.append("vary", "Accept");
  return response;
}

export const config = {
  matcher: ["/((?!_next/|mcp$|opengraph-image|twitter-image).*)"],
};
