/**
 * Local MCP (Model Context Protocol) server for claude-plan-review.
 *
 * Exposes two tools Claude can call to get a plan reviewed WITHOUT being in plan
 * mode (the tools-first creation path):
 *   • plan_review_submit — record a plan (single doc, raw markdown, or a
 *     multi-document tree), open the browser review UI, return the review id.
 *   • plan_review_check  — poll a review for the reviewer's decision.
 *
 * Transport: stdio, newline-delimited JSON-RPC 2.0 (the MCP stdio framing —
 * one JSON message per line, no embedded newlines). Hand-rolled, ZERO new deps.
 * Implemented subset of MCP spec 2025-06-18: initialize handshake,
 * notifications/initialized, tools/list, tools/call, ping.
 *
 * Records go through the SAME store.recordPlan as the PreToolUse hook, so the
 * review UI, dedup, and the hook's own polling all see identical shapes.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, SERVER_FILE } from "./paths.js";
import { buildDenyReason, parsePlan, validateDocs } from "./plan-parse.js";
import { getReview, recordPlan } from "./store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = join(HERE, "server.js");

// Latest MCP protocol revision we implement. We echo the client's requested
// version back when it sends one (the compatible behaviour for a version-
// agnostic tools server), else advertise this.
const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "claude-plan-review", version: "0.4.0" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Long-poll tuning for plan_review_check. RECOMMENDED_WAIT is the value we steer
// Claude to pass — short enough to stay well under Claude Code's MCP limits for a
// stdio server (no per-request timer; ~30-min idle timeout; a main-conversation
// call auto-backgrounds after ~2 min on v2.1.212+), long enough to usually catch
// a fast decision in one call. MAX_WAIT caps a single call; the loop re-issues.
const RECOMMENDED_WAIT_S = 20;
const MAX_WAIT_S = 120;
const CHECK_POLL_MS = 700;

// ---------- server lifecycle (reimplemented locally; mirrors hook.js) ----------
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
  // spawn detached with the SAME runtime running this process (node or bun)
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

// ---------- tool definitions ----------
const TOOLS = [
  {
    name: "plan_review_submit",
    title: "Submit a plan for human review",
    description:
      "Submit an implementation plan for the user to review, comment on, and approve or reject " +
      "in a local browser UI — WITHOUT being in plan mode. Use this whenever the user should sign " +
      "off on a plan before you implement it, especially for a large or multi-part plan that reads " +
      "best as a navigable tree of documents.\n\n" +
      "Provide EXACTLY ONE of these content fields:\n" +
      "  • docs — a pre-structured document tree. Each entry: {slug, title, parent?, body}. " +
      "`slug` is a kebab-case id (^[a-z0-9][a-z0-9-]*$), unique; `title` is a human heading; " +
      "`parent` is another doc's slug (omit it for the single top-level doc — conventionally " +
      "slugged \"root\" — and set children's parent to that slug). Cross-doc links: [[slug]], " +
      "[[slug|text]] or [text](doc:slug).\n" +
      "  • markdown — a single markdown document (no tree).\n" +
      "  • plan — a raw plan string that may embed document-separator markers " +
      "(<!--doc slug=... title=\"...\" parent=...--> lines); the server splits it into a tree.\n\n" +
      "On success returns { reviewId, reviewUrl, projectKey, version }. The call does NOT block on " +
      "the decision — after submitting, call plan_review_check with the returned reviewId to see " +
      "whether the user approved or requested changes. If the plan is structurally invalid the call " +
      "returns an error listing every problem to fix before resubmitting.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: {
          type: "string",
          description:
            "Absolute path of the project/worktree this plan is for (usually your working directory). Required.",
        },
        docs: {
          type: "array",
          description:
            "A pre-structured document tree. Provide this OR markdown OR plan (exactly one).",
          items: {
            type: "object",
            properties: {
              slug: { type: "string", description: "Kebab-case id, unique across docs." },
              title: { type: "string", description: "Human-readable document title." },
              parent: {
                type: "string",
                description:
                  "Slug of the parent doc. Omit for the single top-level doc (conventionally slugged \"root\"); children reference their parent's slug.",
              },
              body: { type: "string", description: "Markdown body of this document." },
            },
            required: ["slug", "title", "body"],
          },
        },
        markdown: {
          type: "string",
          description:
            "A single markdown document. Provide this OR docs OR plan (exactly one).",
        },
        plan: {
          type: "string",
          description:
            "A raw plan string, optionally with <!--doc ...--> separator markers. Provide this OR docs OR markdown (exactly one).",
        },
      },
      required: ["cwd"],
    },
  },
  {
    name: "plan_review_check",
    title: "Check a plan review's decision",
    description:
      "Check whether the user has decided on a plan submitted with plan_review_submit. " +
      "Returns { status: \"pending\" | \"approved\" | \"rejected\", notes?, reason? }.\n\n" +
      "This tool LONG-POLLS: pass `wait` (seconds) and the call blocks server-side until the user " +
      `decides or \`wait\` elapses, then returns. Use \`wait: ${RECOMMENDED_WAIT_S}\` and call it in a ` +
      "loop while the status is \"pending\" — do NOT end your turn while a review is pending. " +
      "Give up only after ~5 hours total and ask the user how to proceed.\n" +
      "  • pending  — the user has not decided yet. Call this tool again immediately with " +
      `wait: ${RECOMMENDED_WAIT_S}.\n` +
      "  • approved — proceed with implementation. `notes` (if present) are the reviewer's comments " +
      "to incorporate as you go (\"approve with comments\").\n" +
      "  • rejected — do NOT implement. `reason` explains the requested changes; revise the plan and " +
      "resubmit with plan_review_submit.",
    inputSchema: {
      type: "object",
      properties: {
        reviewId: {
          type: "string",
          description: "The reviewId returned by plan_review_submit.",
        },
        wait: {
          type: "number",
          description:
            `Seconds to block waiting for a decision before returning (long-poll). Default 0 ` +
            `(return immediately); capped at ${MAX_WAIT_S}. Recommended: ${RECOMMENDED_WAIT_S}. ` +
            `If still pending when it returns, call again with the same wait.`,
        },
      },
      required: ["reviewId"],
    },
  },
];

// ---------- tool implementations ----------
/**
 * Normalize a caller-supplied docs array into the store's tree shape. Mirrors
 * plan-parse's normParent EXACTLY (absent/empty/self ⇒ top-level; "root" is a
 * normal slug reference, so a child with parent:"root" nests under the doc
 * slugged "root") so the stored tree is byte-identical to what the parser
 * produces for the same content.
 */
function normParent(parent, slug) {
  if (parent == null) return null;
  const v = String(parent).trim();
  if (v === "" || v === slug) return null;
  return v;
}
function docsToTree(docs) {
  const normalized = docs.map((d, i) => ({
    slug: d.slug,
    title: d.title,
    parent: normParent(d.parent, d.slug),
    body: d.body ?? "",
    order: i,
  }));
  const root = normalized.find((d) => d.parent === null)?.slug ?? "root";
  return { kind: "tree", root, docs: normalized };
}

function runSubmit(args) {
  const cwd = args?.cwd;
  if (typeof cwd !== "string" || !cwd.trim()) {
    return toolError("plan_review_submit requires `cwd` (the absolute project path).");
  }

  // Exactly one content field.
  const provided = ["docs", "markdown", "plan"].filter(
    (k) => args[k] !== undefined && args[k] !== null,
  );
  if (provided.length === 0) {
    return toolError("Provide exactly one of `docs`, `markdown`, or `plan`.");
  }
  if (provided.length > 1) {
    return toolError(
      `Provide exactly one content field — got ${provided.join(", ")}. Use only one of docs / markdown / plan.`,
    );
  }

  // Build a normalized tree, collecting all validation issues.
  let tree;
  if (provided[0] === "docs") {
    if (!Array.isArray(args.docs) || args.docs.length === 0) {
      return toolError("`docs` must be a non-empty array of {slug, title, parent?, body}.");
    }
    const issues = validateDocs(args.docs);
    if (issues && issues.length) return toolError(buildDenyReason(issues));
    tree = docsToTree(args.docs);
  } else {
    const str = args[provided[0]];
    if (typeof str !== "string" || !str.trim()) {
      return toolError(`\`${provided[0]}\` must be a non-empty string.`);
    }
    let parsed;
    try {
      parsed = parsePlan(str);
    } catch (e) {
      return toolError(`Could not parse the plan: ${e?.message || e}`);
    }
    if (parsed && parsed.error) return toolError(buildDenyReason(parsed.error.issues));
    tree = parsed;
  }

  // Record through the SAME store path the hook uses.
  let recorded;
  try {
    recorded = recordPlan({ cwd, tree, origin: "mcp" });
  } catch (e) {
    return toolError(`Failed to record the plan: ${e?.message || e}`);
  }
  const { key, version, reviewId } = recorded;

  return { pending: { key, version, reviewId, tree } };
}

async function finishSubmit(pending) {
  const { key, version, reviewId, tree } = pending;
  const rootDoc = (tree && tree.root) || "root";
  const port = await ensureServer();
  const reviewUrl = `http://localhost:${port}/?project=${encodeURIComponent(
    key,
  )}&version=${version}&review=${reviewId}&doc=${encodeURIComponent(rootDoc)}`;
  openBrowser(reviewUrl);

  const result = { reviewId, reviewUrl, projectKey: key, version };
  return toolText(
    `Plan submitted for review (version ${version}). The review UI is opening in the browser.\n\n` +
      `Next: call plan_review_check with {reviewId: "${reviewId}", wait: ${RECOMMENDED_WAIT_S}} NOW ` +
      `and keep calling it in a loop while status is "pending". Do not end your turn while the ` +
      `review is pending. Give up and ask the user only after ~5 hours total.\n\n` +
      JSON.stringify(result, null, 2),
    result,
  );
}

async function runCheck(args) {
  const reviewId = args?.reviewId;
  if (typeof reviewId !== "string" || !reviewId.trim()) {
    return toolError("plan_review_check requires `reviewId` (from plan_review_submit).");
  }
  let review = getReview(reviewId);
  if (!review) {
    return toolError(`No review found for reviewId "${reviewId}".`);
  }

  // Long-poll: while `wait` seconds remain and the review is still pending, poll
  // the store. Each `await sleep` yields the event loop, so the stdin read loop
  // keeps dispatching (and answering) OTHER incoming requests meanwhile.
  let wait = Number(args?.wait);
  if (!Number.isFinite(wait) || wait < 0) wait = 0;
  wait = Math.min(wait, MAX_WAIT_S);
  if (wait > 0 && review.status === "pending") {
    const deadline = Date.now() + wait * 1000;
    while (Date.now() < deadline && review.status === "pending") {
      await sleep(CHECK_POLL_MS);
      review = getReview(reviewId) || review;
    }
  }

  const result = { status: review.status };
  if (review.notes) result.notes = review.notes;
  if (review.reason) result.reason = review.reason;

  let hint;
  if (review.status === "approved") {
    hint = result.notes
      ? "APPROVED with comments — proceed with implementation, incorporating each note."
      : "APPROVED — proceed with implementation.";
  } else if (review.status === "rejected") {
    hint = "CHANGES REQUESTED — do not implement; revise per `reason` and resubmit.";
  } else {
    hint =
      `Still pending — call plan_review_check again now with wait:${RECOMMENDED_WAIT_S}. ` +
      "Do not end your turn. Give up after ~5 hours total and ask the user.";
  }
  return toolText(`${hint}\n\n${JSON.stringify(result, null, 2)}`, result);
}

// ---------- tool-result helpers ----------
function toolText(text, structured) {
  const res = { content: [{ type: "text", text }] };
  if (structured !== undefined) res.structuredContent = structured;
  return res;
}
function toolError(text) {
  return { content: [{ type: "text", text }], isError: true };
}

// ---------- JSON-RPC plumbing ----------
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function replyError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  send({ jsonrpc: "2.0", id, error });
}

async function handleMessage(msg) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    // Malformed request with an id → invalid-request error; otherwise ignore.
    if (msg && msg.id !== undefined && msg.id !== null) {
      replyError(msg.id, -32600, "Invalid Request");
    }
    return;
  }
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      const protocolVersion = typeof requested === "string" ? requested : PROTOCOL_VERSION;
      reply(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions:
          "Tools to get a plan reviewed by the user in a local browser UI. Call plan_review_submit " +
          "to open a review, then plan_review_check to poll for the decision.",
      });
      return;
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return; // notifications: no response
    case "ping":
      if (!isNotification) reply(id, {});
      return;
    case "tools/list":
      reply(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments ?? {};
      try {
        if (name === "plan_review_submit") {
          const r = runSubmit(args);
          // runSubmit returns either a tool-result (error) or {pending}
          reply(id, r.pending ? await finishSubmit(r.pending) : r);
        } else if (name === "plan_review_check") {
          reply(id, await runCheck(args));
        } else {
          replyError(id, -32602, `Unknown tool: ${name}`);
        }
      } catch (e) {
        // Never crash the server on a tool bug — report as a tool error.
        reply(id, toolError(`Tool "${name}" failed: ${e?.message || e}`));
      }
      return;
    }
    default:
      if (!isNotification) replyError(id, -32601, `Method not found: ${method}`);
      return;
  }
}

// ---------- stdin loop (newline-delimited JSON) ----------
export function startMcpServer() {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // Unparseable line → JSON-RPC parse error (no id available).
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        continue;
      }
      // Process sequentially; handleMessage is async but ordering of replies is
      // best-effort and each carries its own id, so we don't await here.
      Promise.resolve(handleMessage(msg)).catch(() => {});
    }
  });
  process.stdin.on("end", () => process.exit(0));
}
