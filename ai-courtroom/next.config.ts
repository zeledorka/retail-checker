import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    // Dev 1's AI engine lives in ../ai (imported as "@courtroom/ai" via tsconfig paths).
    // Turbopack refuses to resolve files outside its root, so the root is the repo folder that
    // contains both ai-courtroom/ and ai/. ai/'s own dependencies (@anthropic-ai/sdk, openai, zod)
    // are installed into ../ai/node_modules by this package's "postinstall" script.
    root: path.join(__dirname, ".."),
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  // Also tell the deployment file tracer about ../ai so Vercel bundles it with the functions.
  outputFileTracingRoot: path.join(__dirname, ".."),
};

export default nextConfig;
