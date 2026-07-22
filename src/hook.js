/**
 * Claude Code PreToolUse hook for the ExitPlanMode tool. Runs on Bun or Node ≥18.
 *
 * Verified mechanics (Claude Code 2.1.185):
 *   stdin  = { tool_name:"ExitPlanMode", tool_input:{ plan, planFilePath }, cwd, session_id, tool_use_id, ... }
 *   stdout = { hookSpecificOutput:{ hookEventName:"PreToolUse",
 *                                   permissionDecision:"allow"|"deny",
 *                                   permissionDecisionReason: string } }
 *   deny + reason  → reason is fed back to Claude, which stays in plan mode and revises.
 *   allow          → plan approved, exits plan mode.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, SERVER_FILE } from "./paths.js";
import { buildDenyReason, parsePlan } from "./plan-parse.js";
import { getReview, recordPlan } from "./store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = join(HERE, "server.js");
const TIMEOUT_MS = Number(process.env.PLAN_REVIEW_TIMEOUT || 1800) * 1000;
const POLL_MS = 700;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function emit(payload) {
  process.stdout.write(JSON.stringify(payload));
}

/**
 * Approve and auto-proceed WITHOUT the terminal "Exit plan mode?" keypress.
 *
 * ExitPlanMode reports requiresUserInteraction()=true, so a bare allow falls
 * through to the native prompt. The permission combiner only bypasses the
 * prompt when the hook ALSO returns `updatedInput` (it treats that as "the hook
 * already satisfied the user interaction"). So we echo the original tool input
 * back. `additionalContext`, when present, carries the reviewer's notes into
 * Claude's context — i.e. "approve with comments".
 * (Verified against the Claude Code 2.1.185 binary.)
 */
function allow(toolInput, notes) {
  const hookSpecificOutput = {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    permissionDecisionReason: notes
      ? "Approved with comments in the plan-review UI."
      : "Approved in the plan-review UI.",
    updatedInput: toolInput, // REQUIRED to skip the native approval prompt
  };
  if (notes) hookSpecificOutput.additionalContext = notes;
  emit({
    hookSpecificOutput,
    systemMessage: notes
      ? "✅ Plan approved with comments via plan-review"
      : "✅ Plan approved via plan-review",
  });
}

function deny(reason) {
  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
    systemMessage: "📝 Changes requested via plan-review",
  });
}

function serverPort() {
  try {
    return JSON.parse(readFileSync(SERVER_FILE, "utf8")).port || DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

async function isUp(port) {
  try {
    const res = await fetch(`http://localhost:${port}/api/health`, {
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureServer() {
  const port = serverPort();
  if (await isUp(port)) return port;
  // spawn detached with the SAME runtime that's running this hook (node or bun)
  const child = spawn(process.execPath, [SERVER_SCRIPT, String(port)], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    if (await isUp(port)) return port;
    await sleep(150);
  }
  return port; // best effort
}

function openBrowser(targetUrl) {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", targetUrl] : [targetUrl];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* non-fatal */
  }
}

async function main() {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8")); // fd 0 = stdin (works on node + bun)
  } catch {
    process.exit(0); // can't parse → don't interfere
  }

  if (input.tool_name !== "ExitPlanMode") process.exit(0);

  const toolInput = input.tool_input ?? {};
  const plan = toolInput.plan ?? "";
  if (!plan.trim()) process.exit(0);

  // Parse the plan into a normalized tree (or single-doc). A returned {error}
  // is an EXPLICIT marker-validation failure → deny so Claude stays in plan
  // mode and re-authors. Any thrown exception is unexpected → fail open (exit
  // 0 silently) so a parser bug never blocks the user.
  let tree;
  try {
    tree = parsePlan(plan);
  } catch {
    process.exit(0);
  }
  if (tree && tree.error) {
    deny(buildDenyReason(tree.error.issues));
    process.exit(0);
  }

  let recorded;
  try {
    recorded = recordPlan({
      cwd: input.cwd || process.cwd(),
      sessionId: input.session_id,
      toolUseId: input.tool_use_id,
      planFilePath: input.tool_input?.planFilePath,
      tree,
      origin: "hook",
    });
  } catch {
    process.exit(0); // store failure → don't interfere
  }
  const { key, version, reviewId, reused } = recorded;

  const port = await ensureServer();
  const reviewUrl = `http://localhost:${port}/?project=${encodeURIComponent(
    key,
  )}&version=${version}&review=${reviewId}&doc=root`;
  // When a duplicate hook invocation (a second entry in another settings scope)
  // fired for the SAME ExitPlanMode call, recordPlan reports `reused` — the first
  // invocation already opened the browser, so we must NOT open it again. We still
  // ensure the server is up and poll the shared review, so both processes return
  // the same decision. (Fail-open invariant preserved.)
  if (!reused) openBrowser(reviewUrl);

  // block until the UI resolves the review (or we time out)
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const review = getReview(reviewId);
    if (review && review.status === "approved") {
      allow(toolInput, review.notes);
      process.exit(0);
    }
    if (review && review.status === "rejected") {
      deny(review.reason || "Changes requested in the plan-review UI.");
      process.exit(0);
    }
    await sleep(POLL_MS);
  }

  process.stderr.write(`plan-review: timed out after ${TIMEOUT_MS / 1000}s — falling back\n`);
  process.exit(0);
}

main();
