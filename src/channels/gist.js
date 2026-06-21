/**
 * GitHub Gist storage channel. Stores the plan markdown (only) in a secret
 * gist owned by the user's `gh`-authenticated account. One gist per project:
 * the first save creates it, later saves PATCH the same gist (GitHub keeps the
 * gist's own revision history automatically).
 */
import * as gh from "./gh.js";

export const id = "gist";
export const label = "GitHub Gist";

const REFRESH_CMD = "gh auth refresh -s gist";
const LOGIN_CMD = "gh auth login";

/** Readiness for the UI: can we create a gist right now, and if not, how to fix it. */
export function available() {
  const s = gh.status();
  if (!s.installed)
    return {
      ready: false,
      installed: false,
      authed: false,
      hasGistScope: false,
      reason: "GitHub CLI (gh) is not installed.",
      fixCommand: null,
      fixUrl: "https://cli.github.com",
    };
  if (!s.authed)
    return {
      ready: false,
      installed: true,
      authed: false,
      hasGistScope: false,
      reason: "Not logged in to GitHub.",
      fixCommand: LOGIN_CMD,
    };
  const hasGistScope = s.scopes.includes("gist");
  return {
    ready: hasGistScope,
    installed: true,
    authed: true,
    hasGistScope,
    reason: hasGistScope ? null : "Your gh token is missing the 'gist' scope.",
    fixCommand: hasGistScope ? null : REFRESH_CMD,
    scopes: s.scopes,
  };
}

function ghError(res) {
  const e = new Error(
    res.needsGistScope
      ? `GitHub rejected the gist write — your gh token likely lacks the 'gist' scope. Run: ${REFRESH_CMD}`
      : res.error || "gh request failed",
  );
  e.fixCommand = res.needsGistScope ? REFRESH_CMD : null;
  return e;
}

/** Create a new secret gist. Returns the binding info we persist. */
export function create({ markdown, description, filename }) {
  const file = filename || "plan.md";
  const res = gh.api("POST", "/gists", {
    description: description || "",
    public: false,
    files: { [file]: { content: markdown || "\n" } },
  });
  if (!res.ok) throw ghError(res);
  return {
    id: res.data.id,
    htmlUrl: res.data.html_url,
    filename: file,
    description: description || "",
  };
}

/**
 * Overwrite an existing gist with new content (and optionally a new
 * description / filename). `oldFilename` is the name currently in the gist so
 * we can rename rather than orphan it.
 */
export function update({ id: gistId, markdown, description, filename, oldFilename }) {
  const newName = filename || oldFilename || "plan.md";
  const fileKey = oldFilename || newName;
  const filePatch = { content: markdown || "\n" };
  if (newName !== fileKey) filePatch.filename = newName;
  const res = gh.api("PATCH", `/gists/${gistId}`, {
    description: description ?? "",
    files: { [fileKey]: filePatch },
  });
  if (!res.ok) throw ghError(res);
  return {
    id: res.data.id,
    htmlUrl: res.data.html_url,
    filename: newName,
    description: res.data.description ?? description ?? "",
  };
}
