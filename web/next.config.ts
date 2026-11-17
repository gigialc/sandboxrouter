import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Old routes from the first version of the site.
  redirects() {
    return [
      { source: "/sandboxes", destination: "/#providers", permanent: true },
      { source: "/sandboxes/:id", destination: "/providers/:id", permanent: true },
      { source: "/rankings", destination: "/benchmarks#cost", permanent: true },
      { source: "/use-cases", destination: "/benchmarks#cost", permanent: true },
      // The hosted key's policies live with it, on api.sandboxrouter.ai; the obvious www paths lead there.
      { source: "/terms", destination: "https://api.sandboxrouter.ai/terms", permanent: false },
      { source: "/privacy", destination: "https://api.sandboxrouter.ai/privacy", permanent: false },
      { source: "/refunds", destination: "https://api.sandboxrouter.ai/refunds", permanent: false },
      { source: "/acceptable-use", destination: "https://api.sandboxrouter.ai/acceptable-use", permanent: false },
      { source: "/pricing", destination: "/#hosted", permanent: false },
    ];
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
