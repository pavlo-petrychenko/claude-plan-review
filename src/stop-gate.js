/**
 * Claude Code Stop hook — hard enforcement for tools-first plan reviews.
 *
 * The MCP / HTTP submission paths (plan_review_submit, POST /api/plans) are
 * non-blocking: Claude submits a plan and could end its turn before the user
 * decides. plan_review_check long-polls and its tool-result text steers Claude to
 * keep polling, but nothing PREVENTS the turn from ending. This Stop hook closes
 * that gap: if the turn is about to end while a recent mcp/api-origin review is
 * still pending, it blocks and tells Claude to resume polling.
 *
 * stdin  = { session_id, cwd, stop_hook_active, ... }
 * stdout = { decision:"block", reason } to block; nothing (exit 0) to allow.
 *
 * Invariants (mirror hook.js):
 *   • stop_hook_active === true  → exit 0 immediately (never double-block).
 *   • Fail open on ANY error     → exit 0 so a bug never traps the user's turn.
 *   • Only mcp/api reviews, still pending, created within the last 5 hours are
 *     gated. Hook-origin (and legacy origin-less) reviews are never gated — the
 *     PreToolUse hook already blocks synchronously for those.
 */
import { readFileSync } from "node:fs";
import { projectKey } from "./paths.js";
import { listReviews } from "./store.js";

/** Only reviews this fresh are gated — an abandoned review shouldn't trap forever. */
const GATE_WINDOW_MS = 5 * 60 * 60 * 1000;

function main() {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8")); // fd 0 = stdin (node + bun)
  } catch {
    process.exit(0); // unparseable stdin → don't interfere
  }

  // Never double-block: if we already blocked once this stop cycle, let it end.
  if (input.stop_hook_active) process.exit(0);

  try {
    const cwd = input.cwd || process.cwd();
    const key = projectKey(cwd);
    const cutoff = Date.now() - GATE_WINDOW_MS;
    const pending = listReviews()
      .filter(
        (r) =>
          r.projectKey === key &&
          r.status === "pending" &&
          (r.origin === "mcp" || r.origin === "api") &&
          r.createdAt &&
          Date.parse(r.createdAt) >= cutoff,
      )
      // newest first — reference the most recent pending review
      .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

    if (pending.length) {
      const r = pending[0];
      process.stdout.write(
        JSON.stringify({
          decision: "block",
          reason:
            `A plan review you submitted is still pending (review ${r.id}, version ${r.version}). ` +
            `Call plan_review_check with {reviewId:"${r.id}", wait:20} in a loop until it resolves, ` +
            `then act on the decision. If ~5 hours pass with no decision, ask the user.`,
        }),
      );
    }
  } catch {
    process.exit(0); // any failure → fail open
  }
  process.exit(0);
}

main();
