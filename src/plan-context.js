/**
 * Claude Code PreToolUse hook for the EnterPlanMode tool. Runs on Bun or Node ≥18.
 *
 * Injects the multi-document authoring guidance as `additionalContext` so Claude
 * reaches for the doc-tree format when a plan is large — WITHOUT making a
 * permission decision.
 *
 * CRITICAL: EnterPlanMode is permission-gated and the user's consent to enter
 * plan mode MUST survive this hook. Per the Claude Code hooks doc
 * (https://code.claude.com/docs/en/hooks), a PreToolUse hook may return
 * `additionalContext` inside `hookSpecificOutput` on its own; the valid
 * `permissionDecision` values are "allow" / "deny" / "ask", and OMITTING the
 * field leaves the normal permission flow untouched. We therefore emit NO
 * permissionDecision — only additionalContext — so nothing auto-approves or
 * denies entering plan mode.
 *
 * Fail open (exit 0 silently) on any error, and on any non-EnterPlanMode tool.
 *
 *   stdin  = { tool_name:"EnterPlanMode", tool_input:{…}, cwd, session_id, ... }
 *   stdout = { hookSpecificOutput:{ hookEventName:"PreToolUse", additionalContext } }
 */
import { readFileSync } from "node:fs";

const CONTEXT = [
  "Plan-review tip: when the plan you're about to write is large, multi-part, or",
  "splits into several sections/areas, author it as a navigable TREE OF DOCUMENTS",
  "instead of one long markdown blob. Put one marker per document, each alone on",
  'its own line: <!--doc slug=<kebab-case> title="…" parent=<parent-slug>-->.',
  "Exactly one root doc (omit `parent`); every child sets `parent` to its parent's",
  "slug; cross-link docs with [[slug]]. A small, single-topic plan needs none of",
  "this — write it as plain markdown with no markers. See the plan-review-multidoc",
  "skill for the full syntax and rules.",
].join(" ");

function main() {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8")); // fd 0 = stdin (node + bun)
  } catch {
    process.exit(0); // unparseable stdin → don't interfere
  }

  // Only act on EnterPlanMode; anything else passes through untouched.
  if (input.tool_name !== "EnterPlanMode") process.exit(0);

  try {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          // NO permissionDecision → the user's consent prompt for plan mode
          // stays intact; we only add context.
          additionalContext: CONTEXT,
        },
      }),
    );
  } catch {
    /* non-fatal — fail open */
  }
  process.exit(0);
}

main();
