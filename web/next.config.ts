import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Old routes from the first version of the site.
  redirects() {
    return [
      { source: "/sandboxes", destination: "/#providers", permanent: true },
      { source: "/sandboxes/:id", destination: "/providers/:id", permanent: true },
      { source: "/rankings", destination: "/#providers", permanent: true },
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
