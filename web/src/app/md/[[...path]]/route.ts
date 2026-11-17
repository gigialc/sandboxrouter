import { benchmarksMarkdown, htmlToMarkdown, ORIGIN } from "@/lib/agents";

const md = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/markdown; charset=utf-8", vary: "accept", "cache-control": "public, max-age=600" } });

// Markdown versions of the site's pages, for agents. The proxy sends `Accept: text/markdown` requests and
// `/<page>.md` here. Benchmarks are built from the data (the page shows one tab at a time); other pages are
// their rendered HTML, converted.
export async function GET(req: Request, ctx: { params: Promise<{ path?: string[] }> }) {
  const path = (await ctx.params).path?.join("/") ?? "";
  if (path === "benchmarks") return md(benchmarksMarkdown());
  const res = await fetch(new URL(`/${path}`, req.url), { headers: { accept: "text/html" } });
  if (!res.ok) {
    return md(`# Not found\n\nNo page at /${path}.\n\n- [Index for agents](${ORIGIN}/llms.txt)\n- [Benchmarks](${ORIGIN}/benchmarks.md)\n- [Methodology](${ORIGIN}/methodology.md)\n`, 404);
  }
  return md(htmlToMarkdown(await res.text(), ORIGIN));
}
