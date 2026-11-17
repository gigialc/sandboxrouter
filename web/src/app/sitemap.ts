import type { MetadataRoute } from "next";
import { ORIGIN } from "@/lib/agents";
import { site } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const pages = ["", "/benchmarks", "/methodology", "/providers", "/docs", "/learn", "/security", "/playground"];
  return [
    ...pages.map((p) => ({ url: `${ORIGIN}${p}` })),
    ...site.providers.filter((p) => !p.local).map((p) => ({ url: `${ORIGIN}/providers/${p.id}` })),
  ];
}
