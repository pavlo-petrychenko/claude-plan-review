#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, SERVER_FILE } from "./paths.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = join(HERE, "hook.js");

function canRun(bin) {
  try {
    return spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

function resolveBin(bin) {
  const finder = process.platform === "win32" ? "where" : "which";
  try {
    const r = spawnSync(finder, [bin], { encoding: "utf8" });
    if (r.status === 0) return r.stdout.split(/\r?\n/)[0].trim() || bin;
  } catch {}
  return bin; // fall back to bare name (resolved via PATH at hook time)
}

function chooseRuntime(args) {
  const i = args.indexOf("--runtime");
  if (i >= 0 && args[i + 1]) return args[i + 1];
  // prefer Bun when present, else Node
  return canRun("bun") ? "bun" : "node";
}

function hookCommand(args) {
  const runtime = chooseRuntime(args);
  // global install → use the bare `claude-plan-review` command (resolved via PATH at hook time).
  // We intentionally do NOT hardcode an absolute path: version managers like fnm/nvm expose
  // bins via per-shell paths that don't persist across sessions.
  if (args.includes("--global")) {
    if (canRun("claude-plan-review")) return "claude-plan-review hook";
    // not on PATH → fall back to the package runner
    return runtime === "node" ? "npx claude-plan-review hook" : "bunx claude-plan-review hook";
  }
  if (args.includes("--published") || args.includes("--bunx")) {
    // portable command using the runtime's package runner
    return runtime === "node" ? "npx claude-plan-review hook" : "bunx claude-plan-review hook";
  }
  return `${resolveBin(runtime)} ${HOOK_SCRIPT}`;
}

function readJSON(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function cmdInit(args) {
  const global = args.includes("--global");
  const local = args.includes("--local");
  const dirArg = args.find((a) => !a.startsWith("--") && a !== chooseRuntime(args));
  const settingsFile = global
    ? join(homedir(), ".claude", "settings.json")
    : join(resolve(dirArg || process.cwd()), ".claude", local ? "settings.local.json" : "settings.json");
  mkdirSync(dirname(settingsFile), { recursive: true });

  const settings = readJSON(settingsFile, {});
  settings.hooks ??= {};
  settings.hooks.PreToolUse ??= [];

  const command = hookCommand(args);
  const already = settings.hooks.PreToolUse.some(
    (entry) =>
      entry?.matcher === "ExitPlanMode" &&
      (entry.hooks || []).some((h) => h?.command?.includes("hook.js") || h?.command === command),
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
  console.log(`\nRuntime: ${chooseRuntime(args)}\nCommand: ${command}`);
  console.log(
    `\nReopen the /hooks menu once (or restart Claude Code) ${global ? "in any project" : "in this project"} so the new hook is picked up.\n` +
      `Then finish a plan in plan mode — your browser will open the review.`,
  );
}

async function cmdServe(args) {
  const port = Number(args.find((a) => /^\d+$/.test(a))) || DEFAULT_PORT;
  const { startServer } = await import("./server.js");
  startServer(port);
  console.log(`Open http://localhost:${port}  (Ctrl+C to stop)`);
}

function cmdStop() {
  const info = readJSON(SERVER_FILE, null);
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
  console.log(`claude-plan-review — review Claude Code plans in your browser (runs on Bun or Node ≥18)

Usage:
  claude-plan-review init [dir] [--global] [--local] [--published] [--runtime bun|node]
                                  Wire the ExitPlanMode hook into a project (or all projects).
                                  Runtime auto-detects (Bun if installed, else Node).
                                  --global     → ~/.claude/settings.json (applies to ALL projects)
                                  --local      → .claude/settings.local.json
                                  --published  → portable bunx/npx command (after npm publish)
                                  --runtime    → force a runtime
  claude-plan-review serve [port] Start the review server (default ${DEFAULT_PORT})
  claude-plan-review stop         Stop the running server
  claude-plan-review hook         (internal) the PreToolUse hook entry
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
    await import("./hook.js");
    break;
  default:
    usage();
}
