#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_PORT, SERVER_FILE } from "./paths.ts";

const HOOK_SCRIPT = join(import.meta.dir, "hook.ts");

function hookCommand(args: string[]): string {
  // --bunx → portable command that works on any machine once published to npm.
  // default → absolute path, most reliable for a local clone you control.
  if (args.includes("--bunx")) return "bunx claude-plan-review hook";
  return `${process.execPath} ${HOOK_SCRIPT}`;
}

function readJSON<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function cmdInit(args: string[]) {
  const local = args.includes("--local");
  const dirArg = args.find((a) => !a.startsWith("--"));
  const projectDir = resolve(dirArg || process.cwd());
  const settingsFile = join(
    projectDir,
    ".claude",
    local ? "settings.local.json" : "settings.json",
  );
  mkdirSync(dirname(settingsFile), { recursive: true });

  const settings = readJSON<any>(settingsFile, {});
  settings.hooks ??= {};
  settings.hooks.PreToolUse ??= [];

  const command = hookCommand(args);
  const already = settings.hooks.PreToolUse.some(
    (entry: any) =>
      entry?.matcher === "ExitPlanMode" &&
      (entry.hooks || []).some((h: any) => h?.command?.includes("hook.ts") || h?.command === command),
  );

  if (already) {
    console.log(`✓ ExitPlanMode plan-review hook already present in ${settingsFile}`);
  } else {
    settings.hooks.PreToolUse.push({
      matcher: "ExitPlanMode",
      hooks: [{ type: "command", command, timeout: 1800 }],
    });
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
    console.log(`✓ Wrote ExitPlanMode plan-review hook to ${settingsFile}`);
  }
  console.log(`\nCommand: ${command}`);
  console.log(
    `\nReopen the /hooks menu once (or restart Claude Code) in this project so the new hook is picked up.\n` +
      `Then finish a plan in plan mode — your browser will open the review.`,
  );
}

async function cmdServe(args: string[]) {
  const port = Number(args.find((a) => /^\d+$/.test(a))) || DEFAULT_PORT;
  const { startServer } = await import("./server.ts");
  startServer(port);
  console.log(`Open http://localhost:${port}  (Ctrl+C to stop)`);
}

function cmdStop() {
  const info = readJSON<any>(SERVER_FILE, null);
  if (!info?.pid) {
    console.log("No running plan-review server recorded.");
    return;
  }
  try {
    process.kill(info.pid, "SIGTERM");
    console.log(`Stopped plan-review server (pid ${info.pid}).`);
  } catch {
    console.log("Server not running; clearing stale record.");
  }
  rmSync(SERVER_FILE, { force: true });
}

function usage() {
  console.log(`claude-plan-review — review Claude Code plans in your browser

Usage:
  claude-plan-review init [dir] [--local] [--bunx]
                                            Wire the ExitPlanMode hook into a project
                                            (--local → .claude/settings.local.json,
                                             --bunx  → portable 'bunx claude-plan-review hook' command)
  claude-plan-review serve [port]           Start the review server (default ${DEFAULT_PORT})
  claude-plan-review stop                   Stop the running server
  claude-plan-review hook                   (internal) the PreToolUse hook entry
`);
}

const [sub, ...rest] = process.argv.slice(2);
switch (sub) {
  case "init":
    cmdInit(rest);
    break;
  case "serve":
    await cmdServe(rest);
    break;
  case "stop":
    cmdStop();
    break;
  case "hook":
    await import("./hook.ts");
    break;
  default:
    usage();
}
