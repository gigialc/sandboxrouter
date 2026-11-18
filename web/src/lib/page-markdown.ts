import { benchmarksMarkdown, htmlToMarkdown } from "@/lib/agents";
import { ORIGIN, publicPages } from "@/lib/public-pages";

export async function readPageMarkdown(path: string, requestUrl: string) {
  if (!publicPages.some((page) => page.path === path)) {
    return {
      status: 404,
      body: `# Page not found\n\nFind public pages in the [agent index](${ORIGIN}/llms.txt).\n`,
    };
  }
  if (path === "/benchmarks") return { status: 200, body: benchmarksMarkdown() };

  const response = await fetch(new URL(path, requestUrl), {
    headers: { accept: "text/html" },
    redirect: "manual",
  }).catch(() => null);
  if (!response?.ok || !response.headers.get("content-type")?.includes("text/html")) {
    return {
      status: 502,
      body: `# Page temporarily unavailable\n\nRead the [HTML page](${ORIGIN}${path}) or return to the [agent index](${ORIGIN}/llms.txt).\n`,
    };
  }

  const body = htmlToMarkdown(await response.text(), new URL(path, ORIGIN).href);
  return { status: 200, body };
}
