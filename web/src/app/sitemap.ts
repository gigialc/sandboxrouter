import type { MetadataRoute } from "next";
import { ORIGIN, publicPages } from "@/lib/public-pages";

export default function sitemap(): MetadataRoute.Sitemap {
  return publicPages.map(({ path }) => ({ url: new URL(path, ORIGIN).href }));
}
