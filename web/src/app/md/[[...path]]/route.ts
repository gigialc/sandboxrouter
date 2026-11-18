import { readPageMarkdown } from "@/lib/page-markdown";
import { MARKDOWN, ORIGIN } from "@/lib/public-pages";

export async function GET(req: Request, ctx: { params: Promise<{ path?: string[] }> }) {
  const path = `/${(await ctx.params).path?.join("/") ?? ""}`;
  const { body, status } = await readPageMarkdown(path, req.url);
  const headers = new Headers({
    "content-type": `${MARKDOWN}; charset=utf-8`,
    "cache-control": status === 200 ? "public, max-age=600" : "no-store",
    "access-control-allow-origin": "*",
    vary: "Accept",
  });
  if (status === 200) headers.set("link", `<${ORIGIN}${path}>; rel="canonical"`);
  return new Response(body, { status, headers });
}
