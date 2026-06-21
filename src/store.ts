import { createHash, randomBytes } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { basename, join } from "node:path";
import { PROJECTS_DIR, REVIEWS_DIR, projectDir, projectKey } from "./paths.ts";

// ---------- types ----------
export interface ProjectMeta {
  key: string;
  cwd: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  currentVersion: number;
  latestHash: string;
}
export interface VersionMeta {
  n: number;
  createdAt: string;
  sessionId?: string;
  toolUseId?: string;
  hash: string;
  planFilePath?: string;
}
export interface Comment {
  id: string;
  line: number | null; // 1-based source line, or null for a general comment
  body: string;
  author: string;
  createdAt: string;
}
export interface Review {
  id: string;
  projectKey: string;
  version: number;
  sessionId?: string;
  toolUseId?: string;
  status: "pending" | "approved" | "rejected";
  reason?: string;
  createdAt: string;
  resolvedAt?: string;
}

// ---------- helpers ----------
const enc = (o: unknown) => JSON.stringify(o, null, 2);
const now = () => new Date().toISOString();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const pad = (n: number) => String(n).padStart(4, "0");

function readJSON<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function ensureDirs(key: string) {
  for (const d of ["versions", "comments"]) {
    mkdirSync(join(projectDir(key), d), { recursive: true });
  }
  mkdirSync(REVIEWS_DIR, { recursive: true });
}

const metaPath = (key: string) => join(projectDir(key), "meta.json");
const versionMd = (key: string, n: number) =>
  join(projectDir(key), "versions", `${pad(n)}.md`);
const versionMeta = (key: string, n: number) =>
  join(projectDir(key), "versions", `${pad(n)}.json`);
const commentsPath = (key: string, n: number) =>
  join(projectDir(key), "comments", `${pad(n)}.json`);
const reviewPath = (id: string) => join(REVIEWS_DIR, `${id}.json`);

// ---------- projects / versions ----------
export function getProjectMeta(key: string): ProjectMeta | null {
  return existsSync(metaPath(key)) ? readJSON<ProjectMeta>(metaPath(key), null as any) : null;
}

/**
 * Record a freshly-presented plan. De-dupes by content hash: an identical
 * re-presentation reuses the existing version (and keeps its comments),
 * otherwise a new immutable version is written. Always creates a new review.
 */
export function recordPlan(opts: {
  cwd: string;
  plan: string;
  planFilePath?: string;
  sessionId?: string;
  toolUseId?: string;
}): { key: string; version: number; reviewId: string } {
  const key = projectKey(opts.cwd);
  ensureDirs(key);
  const hash = sha(opts.plan);

  let meta = getProjectMeta(key);
  let version: number;

  if (meta && meta.latestHash === hash) {
    // identical plan re-presented → reuse latest version
    version = meta.currentVersion;
    meta.updatedAt = now();
  } else {
    version = (meta?.currentVersion ?? 0) + 1;
    writeFileSync(versionMd(key, version), opts.plan);
    const vmeta: VersionMeta = {
      n: version,
      createdAt: now(),
      sessionId: opts.sessionId,
      toolUseId: opts.toolUseId,
      hash,
      planFilePath: opts.planFilePath,
    };
    writeFileSync(versionMeta(key, version), enc(vmeta));
    writeFileSync(commentsPath(key, version), enc([] as Comment[]));
    meta = {
      key,
      cwd: opts.cwd,
      name: basename(opts.cwd) || key,
      createdAt: meta?.createdAt ?? now(),
      updatedAt: now(),
      currentVersion: version,
      latestHash: hash,
    };
  }
  writeFileSync(metaPath(key), enc(meta));

  const reviewId = randomBytes(8).toString("hex");
  const review: Review = {
    id: reviewId,
    projectKey: key,
    version,
    sessionId: opts.sessionId,
    toolUseId: opts.toolUseId,
    status: "pending",
    createdAt: now(),
  };
  writeFileSync(reviewPath(reviewId), enc(review));
  return { key, version, reviewId };
}

export function listProjects(): Array<ProjectMeta & { versions: number; pending: number }> {
  if (!existsSync(PROJECTS_DIR)) return [];
  const pendingByKey = new Map<string, number>();
  for (const r of listReviews()) {
    if (r.status === "pending")
      pendingByKey.set(r.projectKey, (pendingByKey.get(r.projectKey) ?? 0) + 1);
  }
  return readdirSync(PROJECTS_DIR)
    .map((key) => getProjectMeta(key))
    .filter((m): m is ProjectMeta => !!m)
    .map((m) => ({
      ...m,
      versions: listVersions(m.key).length,
      pending: pendingByKey.get(m.key) ?? 0,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function listVersions(key: string): VersionMeta[] {
  const dir = join(projectDir(key), "versions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJSON<VersionMeta>(join(dir, f), null as any))
    .filter(Boolean)
    .sort((a, b) => a.n - b.n);
}

export function getVersion(key: string, n: number): { markdown: string; meta: VersionMeta } | null {
  if (!existsSync(versionMd(key, n))) return null;
  return {
    markdown: readFileSync(versionMd(key, n), "utf8"),
    meta: readJSON<VersionMeta>(versionMeta(key, n), { n, createdAt: "", hash: "" }),
  };
}

// ---------- comments ----------
export function listComments(key: string, n: number): Comment[] {
  return readJSON<Comment[]>(commentsPath(key, n), []);
}

export function addComment(
  key: string,
  n: number,
  c: { line: number | null; body: string; author?: string },
): Comment {
  const comments = listComments(key, n);
  const comment: Comment = {
    id: randomBytes(6).toString("hex"),
    line: c.line,
    body: c.body,
    author: c.author || "me",
    createdAt: now(),
  };
  comments.push(comment);
  writeFileSync(commentsPath(key, n), enc(comments));
  return comment;
}

export function deleteComment(key: string, n: number, id: string): boolean {
  const comments = listComments(key, n);
  const next = comments.filter((c) => c.id !== id);
  if (next.length === comments.length) return false;
  writeFileSync(commentsPath(key, n), enc(next));
  return true;
}

// ---------- reviews ----------
export function listReviews(): Review[] {
  if (!existsSync(REVIEWS_DIR)) return [];
  return readdirSync(REVIEWS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJSON<Review>(join(REVIEWS_DIR, f), null as any))
    .filter(Boolean);
}

export function getReview(id: string): Review | null {
  return existsSync(reviewPath(id)) ? readJSON<Review>(reviewPath(id), null as any) : null;
}

/** Resolve a review; for reject, compile its version's comments into the reason. */
export function resolveReview(
  id: string,
  decision: "approve" | "reject",
): Review | null {
  const review = getReview(id);
  if (!review) return null;
  review.status = decision === "approve" ? "approved" : "rejected";
  review.resolvedAt = now();
  if (decision === "reject") {
    review.reason = compileReason(review.projectKey, review.version);
  }
  writeFileSync(reviewPath(id), enc(review));
  return review;
}

function compileReason(key: string, n: number): string {
  const comments = listComments(key, n);
  const lineComments = comments.filter((c) => c.line != null).sort((a, b) => a.line! - b.line!);
  const general = comments.filter((c) => c.line == null);
  const md = getVersion(key, n)?.markdown ?? "";
  const lines = md.split("\n");

  const parts: string[] = [
    "The reviewer requested changes to this plan in the plan-review UI. " +
      "Address each comment below, then re-present the revised plan with ExitPlanMode.",
  ];
  if (lineComments.length) {
    parts.push("\nLine comments:");
    for (const c of lineComments) {
      const src = (lines[c.line! - 1] ?? "").trim();
      parts.push(`- [line ${c.line}] "${src}"\n    → ${c.body}`);
    }
  }
  if (general.length) {
    parts.push("\nGeneral comments:");
    for (const c of general) parts.push(`- ${c.body}`);
  }
  if (!lineComments.length && !general.length) {
    parts.push("\n(No specific comments were left — please reconsider and improve the plan.)");
  }
  return parts.join("\n");
}

// ---------- maintenance ----------
export function pruneResolvedReviews(maxAgeMs = 1000 * 60 * 60 * 24 * 7) {
  const cutoff = Date.now() - maxAgeMs;
  for (const r of listReviews()) {
    if (r.status !== "pending" && r.resolvedAt && Date.parse(r.resolvedAt) < cutoff) {
      rmSync(reviewPath(r.id), { force: true });
    }
  }
}
