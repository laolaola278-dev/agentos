#!/usr/bin/env node
/**
 * Test runner wrapper.
 *
 * Two jobs:
 *  1. Pick a scratch root for test temp directories. `os.tmpdir()` resolves to
 *     `C:\Users\<user>\AppData\Local\Temp` on Windows, and the project rule is
 *     that scratch data never lands on the system drive. Honour
 *     AGENTOS_TEST_TMP when set; otherwise prefer the first available
 *     non-system drive (F:, G:, E:, D:).
 *  2. Forward everything else to the tsx test runner unchanged.
 *
 * Usage: node scripts/test.mjs [runner flags] <files...>
 */
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SYSTEM_DRIVE = (process.env.SystemDrive || "C:").toUpperCase();

function candidateRoots() {
  const roots = [];
  for (const drive of ["F:", "G:", "E:", "D:"]) {
    if (drive.toUpperCase() !== SYSTEM_DRIVE) roots.push(path.join(drive, path.sep));
  }
  roots.push(os.tmpdir());
  return roots;
}

async function pickScratchRoot() {
  if (process.env.AGENTOS_TEST_TMP) return path.resolve(process.env.AGENTOS_TEST_TMP);
  if (process.platform !== "win32") return os.tmpdir();
  for (const root of candidateRoots()) {
    try {
      await fsp.mkdir(path.join(root, "agentos-test-tmp"), { recursive: true });
      return path.join(root, "agentos-test-tmp");
    } catch {
      // try the next drive
    }
  }
  return os.tmpdir();
}

const root = await pickScratchRoot();
if (process.platform === "win32" && path.parse(root).root.toUpperCase() === SYSTEM_DRIVE) {
  console.warn(`[test] WARNING: scratch root ${root} is on the system drive (${SYSTEM_DRIVE}). Set AGENTOS_TEST_TMP to relocate it.`);
}

const runner = process.platform === "win32" ? "npx.cmd" : "npx";
const args = ["tsx", "--test", ...process.argv.slice(2)];

const child = spawn(runner, args, {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, AGENTOS_TEST_TMP: root },
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
