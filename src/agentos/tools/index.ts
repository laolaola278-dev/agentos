import { ToolRegistry } from "./registry";
import { FilesystemTool } from "./filesystem";
import { TerminalTool, ProcessTool, ProcessManager } from "./terminal";
import { GitTool } from "./git";
import { HttpTool } from "./http";

export * from "./registry";
export * from "./filesystem";
export * from "./terminal";
export * from "./git";
export * from "./http";

export interface DefaultToolsOptions {
  processes?: ProcessManager;
  allowDangerous?: boolean;
  allowedHosts?: string[];
  shell?: string;
}

export function createDefaultToolRegistry(opts: DefaultToolsOptions = {}): { registry: ToolRegistry; processes: ProcessManager } {
  const processes = opts.processes ?? new ProcessManager();
  const registry = new ToolRegistry()
    .register(new FilesystemTool())
    .register(new TerminalTool(processes, { allowDangerous: opts.allowDangerous, shell: opts.shell }))
    .register(new ProcessTool(processes))
    .register(new GitTool())
    .register(new HttpTool({ allowedHosts: opts.allowedHosts }));
  return { registry, processes };
}
