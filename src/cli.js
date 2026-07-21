#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, SERVER_FILE } from "./paths.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = join(HERE, "hook.js");
const STOP_GATE_SCRIPT = join(HERE, "stop-gate.js");
const CLI_SCRIPT = fileURLToPath(import.meta.url);
const SKILL_SRC = join(HERE, "..", "skill", "SKILL.md");

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
  // global install → always route through the package runner (npx/bunx), never the bare
  // `claude-plan-review` command. Version managers like fnm/nvm expose global bins only via a
  // per-shell PATH set up by interactive shell init. `canRun` succeeds here (init runs in an
  // interactive shell) but Claude Code fires hooks in a NON-interactive shell where that PATH
  // is absent, so the bare command resolves at init time yet fails — silently — at hook time.
  // `npx`/`bunx` are inherited reliably from Claude Code's launching env, so they work either way.
  if (args.includes("--global")) {
    return runtime === "node" ? "npx claude-plan-review hook" : "bunx claude-plan-review hook";
  }
  if (args.includes("--published") || args.includes("--bunx")) {
    // portable command using the runtime's package runner
    return runtime === "node" ? "npx claude-plan-review hook" : "bunx claude-plan-review hook";
  }
  return `${resolveBin(runtime)} ${HOOK_SCRIPT}`;
}

// The Stop-hook gate command, mirroring hookCommand's runtime routing: global/
// published installs go through the package runner (npx/bunx) so they resolve in
// Claude Code's non-interactive env; a local install points straight at the
// stop-gate.js script (which runs on import, like hook.js).
function stopGateCommand(args) {
  const runtime = chooseRuntime(args);
  if (args.includes("--global") || args.includes("--published") || args.includes("--bunx")) {
    return runtime === "node"
      ? "npx claude-plan-review stop-gate"
      : "bunx claude-plan-review stop-gate";
  }
  return `${resolveBin(runtime)} ${STOP_GATE_SCRIPT}`;
}

// The program + args that launch the MCP server, mirroring hookCommand's
// runtime routing: global/published installs go through the package runner
// (npx/bunx) so they resolve in Claude Code's non-interactive env; a local
// install points straight at this cli.js.
function mcpRunnerArgs(args) {
  const runtime = chooseRuntime(args);
  if (args.includes("--global") || args.includes("--published") || args.includes("--bunx")) {
    return runtime === "node"
      ? ["npx", "claude-plan-review", "mcp"]
      : ["bunx", "claude-plan-review", "mcp"];
  }
  return [resolveBin(runtime), CLI_SCRIPT, "mcp"];
}

// Register the local MCP server with the `claude` CLI (user scope) so the
// plan_review_submit / plan_review_check tools are available in every project.
// If the `claude` CLI isn't on PATH, print the exact command to run by hand.
function registerMcp(args) {
  const runner = mcpRunnerArgs(args);
  const addArgs = ["mcp", "add", "--scope", "user", "plan-review", "--", ...runner];
  const manual = `claude ${addArgs.join(" ")}`;
  if (canRun("claude")) {
    const r = spawnSync("claude", addArgs, { stdio: "inherit" });
    if (r.status === 0) {
      console.log("✓ Registered the plan-review MCP server (plan_review_submit / plan_review_check tools).");
    } else {
      console.log(
        `… couldn't auto-register the MCP server (it may already exist). To (re)register, run:\n  ${manual}`,
      );
    }
  } else {
    console.log(
      `To enable the plan_review_submit / plan_review_check tools, register the MCP server:\n  ${manual}`,
    );
  }
}

// Copy the bundled skill into ~/.claude/skills so it auto-triggers in every project.
function installSkill() {
  const destDir = join(homedir(), ".claude", "skills", "plan-review-multidoc");
  const dest = join(destDir, "SKILL.md");
  mkdirSync(destDir, { recursive: true });
  copyFileSync(SKILL_SRC, dest);
  console.log(`✓ Installed plan-review-multidoc skill to ${dest}`);
}

const CLAUDE_MD_START = "<!-- plan-review:start -->";
const CLAUDE_MD_END = "<!-- plan-review:end -->";
const CLAUDE_MD_BODY = `## Plan review

When a plan is large or splits into multiple sections/areas, author it as a
navigable **tree of documents** using the \`plan-review-multidoc\` markers
(root overview + linked subpages) rather than one long markdown blob. Small,
single-topic plans stay as plain markdown. See the \`plan-review-multidoc\` skill.`;

function claudeMdBlock() {
  return `${CLAUDE_MD_START}\n${CLAUDE_MD_BODY}\n${CLAUDE_MD_END}`;
}

// Append (or refresh) the CLAUDE.md guidance block idempotently, fenced by
// <!-- plan-review:start/end --> so re-running only ever updates that region.
function writeClaudeMd(targetFile) {
  mkdirSync(dirname(targetFile), { recursive: true });
  const block = claudeMdBlock();
  let existing = "";
  try {
    existing = readFileSync(targetFile, "utf8");
  } catch {
    existing = "";
  }
  const startIdx = existing.indexOf(CLAUDE_MD_START);
  const endIdx = existing.indexOf(CLAUDE_MD_END);
  let next;
  if (startIdx >= 0 && endIdx > startIdx) {
    next = existing.slice(0, startIdx) + block + existing.slice(endIdx + CLAUDE_MD_END.length);
  } else {
    next = existing.trim() ? `${existing.replace(/\s*$/, "")}\n\n${block}\n` : `${block}\n`;
  }
  writeFileSync(targetFile, next);
  console.log(`✓ Wrote plan-review guidance block to ${targetFile}`);
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
  settings.hooks.Stop ??= [];

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

  // Stop-hook gate: blocks the turn from ending while a tools-first (mcp/api)
  // review is still pending. Matcher-less (Stop has no tool matcher).
  const stopCommand = stopGateCommand(args);
  const stopAlready = settings.hooks.Stop.some((entry) =>
    (entry.hooks || []).some(
      (h) => h?.command?.includes("stop-gate") || h?.command === stopCommand,
    ),
  );
  if (stopAlready) {
    console.log(`✓ Stop plan-review gate already present in ${settingsFile}`);
  } else {
    settings.hooks.Stop.push({
      hooks: [{ type: "command", command: stopCommand, timeout: 10 }],
    });
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
    console.log(`✓ Wrote Stop plan-review gate to ${settingsFile}`);
  }

  console.log(
    `\nRuntime: ${chooseRuntime(args)}\nHook:    ${command}\nStop:    ${stopCommand}`,
  );

  // Skill: auto-triggers the multi-document plan authoring in every project.
  if (args.includes("--no-skill")) {
    console.log("\n(skipped skill install — --no-skill)");
  } else {
    try {
      installSkill();
    } catch (e) {
      console.log(`⚠ Could not install the skill: ${e?.message || e}`);
    }
  }

  // MCP server: enables the plan_review_submit / plan_review_check tools.
  console.log("");
  registerMcp(args);

  // CLAUDE.md guidance block: written on --write-claude-md, printed otherwise.
  const claudeMdFile = global
    ? join(homedir(), ".claude", "CLAUDE.md")
    : join(resolve(dirArg || process.cwd()), "CLAUDE.md");
  if (args.includes("--write-claude-md")) {
    console.log("");
    writeClaudeMd(claudeMdFile);
  } else {
    console.log(
      `\nAdd this to ${global ? "~/.claude/CLAUDE.md" : "your project's CLAUDE.md"} ` +
        `(or re-run with --write-claude-md to append it automatically):\n\n${claudeMdBlock()}`,
    );
  }

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

async function cmdChannels() {
  const { listChannelStatus } = await import("./channels/index.js");
  const list = listChannelStatus();
  if (!list.length) {
    console.log("No storage channels registered.");
    return;
  }
  console.log("Storage channels:\n");
  for (const c of list) {
    const mark = c.ready ? "✓" : "✗";
    console.log(`  ${mark} ${c.label} (${c.id})`);
    if (!c.ready) {
      if (c.reason) console.log(`      ${c.reason}`);
      if (c.fixCommand) console.log(`      fix: ${c.fixCommand}`);
      else if (c.fixUrl) console.log(`      see: ${c.fixUrl}`);
    } else if (c.scopes) {
      console.log(`      gh scopes: ${c.scopes.join(", ")}`);
    }
  }
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

function cmdSkill() {
  installSkill();
  console.log(
    "\nThe plan-review-multidoc skill auto-triggers when a plan is large or splits into sections.\n" +
      "Restart Claude Code (or start a new session) to pick it up.",
  );
}

function usage() {
  console.log(`claude-plan-review — review Claude Code plans in your browser (runs on Bun or Node ≥18)

Usage:
  claude-plan-review init [dir] [--global] [--local] [--published] [--runtime bun|node]
                                  [--no-skill] [--write-claude-md]
                                  Wire the ExitPlanMode hook + the Stop-hook gate into a project
                                  (or all projects), install the plan-review-multidoc skill, and
                                  register the MCP server.
                                  Runtime auto-detects (Bun if installed, else Node).
                                  --global         → ~/.claude/settings.json (applies to ALL projects)
                                  --local          → .claude/settings.local.json
                                  --published      → portable bunx/npx command (after npm publish)
                                  --runtime        → force a runtime
                                  --no-skill       → don't install the multi-doc plan skill
                                  --write-claude-md→ append the CLAUDE.md guidance block (else printed)
  claude-plan-review serve [port] Start the review server (default ${DEFAULT_PORT})
  claude-plan-review stop         Stop the running server
  claude-plan-review channels     Show storage-channel readiness (e.g. gh / gist)
  claude-plan-review skill        (Re)install the plan-review-multidoc skill into ~/.claude/skills
  claude-plan-review mcp          (internal) run the stdio MCP server (plan_review_* tools)
  claude-plan-review hook         (internal) the PreToolUse hook entry
  claude-plan-review stop-gate    (internal) the Stop hook entry (blocks on a pending tools-first review)
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
  case "channels":
    await cmdChannels();
    break;
  case "skill":
    cmdSkill();
    break;
  case "mcp": {
    const { startMcpServer } = await import("./mcp.js");
    startMcpServer();
    break;
  }
  case "hook":
    await import("./hook.js");
    break;
  case "stop-gate":
    await import("./stop-gate.js");
    break;
  default:
    usage();
}
