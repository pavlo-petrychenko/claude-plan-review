/**
 * Claude Code PreToolUse hook for the ExitPlanMode tool.
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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PORT, SERVER_FILE } from "./paths.ts";
import { getReview, recordPlan } from "./store.ts";

const SERVER_SCRIPT = join(import.meta.dir, "server.ts");
const TIMEOUT_MS = Number(process.env.PLAN_REVIEW_TIMEOUT || 1800) * 1000;
const POLL_MS = 700;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function out(decision: "allow" | "deny", reason: string, sys: string) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
      systemMessage: sys,
    }),
  );
}

function serverPort(): number {
  try {
    return JSON.parse(readFileSync(SERVER_FILE, "utf8")).port || DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

async function isUp(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/api/health`, {
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureServer(): Promise<number> {
  let port = serverPort();
  if (await isUp(port)) return port;
  // spawn detached so it outlives this hook process
  const child = spawn(process.execPath, [SERVER_SCRIPT, String(port)], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    if (await isUp(port)) return port;
    await sleep(150);
  }
  return port; // best effort; browser open may still race in
}

function openBrowser(targetUrl: string) {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", targetUrl] : [targetUrl];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* non-fatal */
  }
}

async function main() {
  const raw = await Bun.stdin.text();
  let input: any = {};
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0); // can't parse → don't interfere
  }

  if (input.tool_name !== "ExitPlanMode") process.exit(0);

  const plan: string = input.tool_input?.plan ?? "";
  if (!plan.trim()) process.exit(0);

  const { key, version, reviewId } = recordPlan({
    cwd: input.cwd || process.cwd(),
    plan,
    planFilePath: input.tool_input?.planFilePath,
    sessionId: input.session_id,
    toolUseId: input.tool_use_id,
  });

  const port = await ensureServer();
  const reviewUrl = `http://localhost:${port}/?project=${encodeURIComponent(
    key,
  )}&version=${version}&review=${reviewId}`;
  openBrowser(reviewUrl);

  // block until the UI resolves the review (or we time out)
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const review = getReview(reviewId);
    if (review && review.status === "approved") {
      out("allow", "Approved in the plan-review UI.", "✅ Plan approved via plan-review");
      process.exit(0);
    }
    if (review && review.status === "rejected") {
      out(
        "deny",
        review.reason || "Changes requested in the plan-review UI.",
        "📝 Changes requested via plan-review",
      );
      process.exit(0);
    }
    await sleep(POLL_MS);
  }

  // timed out → emit nothing so Claude Code's normal plan-approval flow takes over
  process.stderr.write(`plan-review: timed out after ${TIMEOUT_MS / 1000}s — falling back\n`);
  process.exit(0);
}

main();
