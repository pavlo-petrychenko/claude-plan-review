import { homedir } from "node:os";
import { join } from "node:path";

/** Top-level storage root — NOT inside any project repo (no gitignore needed). */
export const ROOT =
  process.env.PLAN_REVIEW_HOME || join(homedir(), ".claude", "plan-review");

export const PROJECTS_DIR = join(ROOT, "projects");
export const REVIEWS_DIR = join(ROOT, "reviews");
export const SERVER_FILE = join(ROOT, "server.json");

export const DEFAULT_PORT = Number(process.env.PLAN_REVIEW_PORT || 4607);

/**
 * Derive a stable per-worktree key from an absolute cwd, mirroring the
 * sanitized-path convention Claude Code itself uses for ~/.claude/projects/.
 * Distinct git worktrees have distinct paths → distinct keys automatically.
 */
export function projectKey(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function projectDir(key) {
  return join(PROJECTS_DIR, key);
}

const pad = (n) => String(n).padStart(4, "0");

/** Directory holding a tree version's manifest + per-doc markdown (tree kind only). */
export function versionDir(key, n) {
  return join(projectDir(key), "versions", pad(n));
}

/** manifest.json path inside a tree version's directory. */
export function manifestPath(key, n) {
  return join(versionDir(key, n), "manifest.json");
}

/** Path to one document file (e.g. "api.md") inside a tree version's directory. */
export function docPath(key, n, file) {
  return join(versionDir(key, n), file);
}
