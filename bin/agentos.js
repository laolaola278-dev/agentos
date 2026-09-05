#!/usr/bin/env node
// AgentOS launcher: runs the TypeScript CLI from any working directory.
const { spawn } = require("node:child_process");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");
const loader = pathToFileURL(require.resolve("tsx", { paths: [root] })).href;
const cli = path.join(root, "src", "agentos", "cli.ts");
const child = spawn(process.execPath, ["--import", loader, cli, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, NODE_NO_WARNINGS: process.env.NODE_NO_WARNINGS ?? "1" },
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
