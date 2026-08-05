import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // These do native/binary __dirname-based path resolution at module-load
  // time (canvas' native binding loader, youtube-dl-exec/tiktok-api-dl's
  // bundled-binary lookup) — bundling them was what leaked a `__dirname`
  // reference into the Edge proxy runtime (which has no __dirname) via
  // Next's file tracer over-including the whole project. Keeping them
  // external means they're require()'d normally at runtime instead.
  serverExternalPackages: ["canvas", "youtube-dl-exec", "@tobyg74/tiktok-api-dl"],
};

export default nextConfig;
