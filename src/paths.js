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
