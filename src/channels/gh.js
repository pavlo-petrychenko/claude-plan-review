/**
 * Thin wrapper around the GitHub CLI (`gh`). Runs on Bun or Node ≥18.
 *
 * We shell out to `gh` rather than holding our own token: if the user has
 * already `gh auth login`'d, we store no secrets at all. All request bodies are
 * piped via STDIN (never argv), so plan content / descriptions can't break
 * argument parsing.
 */
import { spawnSync } from "node:child_process";

function run(args, { input } = {}) {
  try {
    const r = spawnSync("gh", args, {
      input: input ?? undefined,
      encoding: "utf8",
      // gh writes `auth status` to stderr; capture both streams.
    });
    return {
      ok: r.status === 0,
      status: r.status,
      stdout: r.stdout || "",
      stderr: r.stderr || "",
      spawnError: r.error || null,
    };
  } catch (e) {
    return { ok: false, status: null, stdout: "", stderr: "", spawnError: e };
  }
}

/** Is `gh` on PATH at all? */
export function installed() {
  return run(["--version"]).ok;
}

/**
 * Readiness probe: { installed, authed, scopes:[...] }.
 * `gh auth status` exits non-zero when not logged in; its human output (on
 * stderr) carries a "Token scopes: 'gist', 'repo', …" line we parse.
 */
export function status() {
  if (!installed()) return { installed: false, authed: false, scopes: [] };
  const r = run(["auth", "status"]);
  const text = `${r.stdout}\n${r.stderr}`;
  const authed = r.ok || /Logged in to/i.test(text);
  let scopes = [];
  const m = text.match(/Token scopes:\s*(.+)/i);
  if (m) {
    scopes = m[1]
      .split(",")
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
  }
  return { installed: true, authed, scopes };
}

/**
 * Call the GitHub REST API through gh, sending `body` as JSON on stdin.
 * Returns { ok, data, error, needsGistScope }.
 */
export function api(method, path, body) {
  const args = ["api", "-X", method.toUpperCase(), path];
  let input;
  if (body !== undefined) {
    args.push("--input", "-");
    input = JSON.stringify(body);
  }
  const r = run(args, { input });
  if (r.ok) {
    try {
      return { ok: true, data: JSON.parse(r.stdout || "null") };
    } catch {
      return { ok: true, data: null };
    }
  }
  const errText = `${r.stderr}${r.stdout}`.trim();
  const httpStatus = Number(errText.match(/HTTP (\d{3})/)?.[1]) || null;
  // A genuine missing-scope error names the scope explicitly ("requires the
  // 'gist' scope"). A bare 404 just means the gist is gone — don't conflate them.
  const needsGistScope = /gist/i.test(errText) && /scope|requires/i.test(errText);
  return {
    ok: false,
    httpStatus,
    error: errText || (r.spawnError ? String(r.spawnError.message || r.spawnError) : "gh failed"),
    needsGistScope,
  };
}
