import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  // keep the agent runtime (child processes, node:sqlite, pg) out of the bundler
  serverExternalPackages: ["pg", "tsx"],
};

export default nextConfig;
