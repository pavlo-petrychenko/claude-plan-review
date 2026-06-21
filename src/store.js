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
import { PROJECTS_DIR, REVIEWS_DIR, projectDir, projectKey } from "./paths.js";

// ---------- helpers ----------
const enc = (o) => JSON.stringify(o, null, 2);
const now = () => new Date().toISOString();
const sha = (s) => createHash("sha256").update(s).digest("hex");
const pad = (n) => String(n).padStart(4, "0");

function readJSON(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function ensureDirs(key) {
  for (const d of ["versions", "comments"]) {
    mkdirSync(join(projectDir(key), d), { recursive: true });
  }
  mkdirSync(REVIEWS_DIR, { recursive: true });
}

const metaPath = (key) => join(projectDir(key), "meta.json");
const versionMd = (key, n) => join(projectDir(key), "versions", `${pad(n)}.md`);
const versionMeta = (key, n) => join(projectDir(key), "versions", `${pad(n)}.json`);
const commentsPath = (key, n) => join(projectDir(key), "comments", `${pad(n)}.json`);
const reviewPath = (id) => join(REVIEWS_DIR, `${id}.json`);

// ---------- projects / versions ----------
export function getProjectMeta(key) {
  return existsSync(metaPath(key)) ? readJSON(metaPath(key), null) : null;
}

// ---------- storage-channel bindings ----------
/** All channel bindings for a project, e.g. { gist: { id, htmlUrl, … } }. */
export function getStorage(key) {
  return getProjectMeta(key)?.storage ?? {};
}

/** Persist (or update) the binding for one channel on a project. */
export function setStorage(key, channelId, info) {
  const meta = getProjectMeta(key);
  if (!meta) return null;
  meta.storage ??= {};
  meta.storage[channelId] = { ...meta.storage[channelId], ...info, savedAt: now() };
  meta.updatedAt = now();
  writeFileSync(metaPath(key), enc(meta));
  return meta.storage[channelId];
}

/**
 * Record a freshly-presented plan. De-dupes by content hash: an identical
 * re-presentation reuses the existing version (and keeps its comments),
 * otherwise a new immutable version is written. Always creates a new review.
 */
export function recordPlan(opts) {
  const key = projectKey(opts.cwd);
  ensureDirs(key);
  const hash = sha(opts.plan);

  let meta = getProjectMeta(key);
  let version;

  if (meta && meta.latestHash === hash) {
    // identical plan re-presented → reuse latest version
    version = meta.currentVersion;
    meta.updatedAt = now();
  } else {
    version = (meta?.currentVersion ?? 0) + 1;
    writeFileSync(versionMd(key, version), opts.plan);
    writeFileSync(
      versionMeta(key, version),
      enc({
        n: version,
        createdAt: now(),
        sessionId: opts.sessionId,
        toolUseId: opts.toolUseId,
        hash,
        planFilePath: opts.planFilePath,
      }),
    );
    writeFileSync(commentsPath(key, version), enc([]));
    meta = {
      key,
      cwd: opts.cwd,
      name: basename(opts.cwd) || key,
      createdAt: meta?.createdAt ?? now(),
      updatedAt: now(),
      currentVersion: version,
      latestHash: hash,
      // carry forward storage-channel bindings — they outlive individual versions
      storage: meta?.storage ?? {},
    };
  }
  writeFileSync(metaPath(key), enc(meta));

  const reviewId = randomBytes(8).toString("hex");
  writeFileSync(
    reviewPath(reviewId),
    enc({
      id: reviewId,
      projectKey: key,
      version,
      sessionId: opts.sessionId,
      toolUseId: opts.toolUseId,
      status: "pending",
      createdAt: now(),
    }),
  );
  return { key, version, reviewId };
}

export function listProjects() {
  if (!existsSync(PROJECTS_DIR)) return [];
  const pendingByKey = new Map();
  for (const r of listReviews()) {
    if (r.status === "pending")
      pendingByKey.set(r.projectKey, (pendingByKey.get(r.projectKey) ?? 0) + 1);
  }
  return readdirSync(PROJECTS_DIR)
    .map((key) => getProjectMeta(key))
    .filter(Boolean)
    .map((m) => ({
      ...m,
      versions: listVersions(m.key).length,
      pending: pendingByKey.get(m.key) ?? 0,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function listVersions(key) {
  const dir = join(projectDir(key), "versions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJSON(join(dir, f), null))
    .filter(Boolean)
    .sort((a, b) => a.n - b.n);
}

export function getVersion(key, n) {
  if (!existsSync(versionMd(key, n))) return null;
  return {
    markdown: readFileSync(versionMd(key, n), "utf8"),
    meta: readJSON(versionMeta(key, n), { n, createdAt: "", hash: "" }),
  };
}

// ---------- comments ----------
export function listComments(key, n) {
  return readJSON(commentsPath(key, n), []);
}

export function addComment(key, n, c) {
  const comments = listComments(key, n);
  const comment = {
    id: randomBytes(6).toString("hex"),
    line: c.line,
    lineEnd: c.line == null ? null : (c.lineEnd ?? c.line),
    body: c.body,
    author: c.author || "me",
    createdAt: now(),
  };
  comments.push(comment);
  writeFileSync(commentsPath(key, n), enc(comments));
  return comment;
}

export function deleteComment(key, n, id) {
  const comments = listComments(key, n);
  const next = comments.filter((c) => c.id !== id);
  if (next.length === comments.length) return false;
  writeFileSync(commentsPath(key, n), enc(next));
  return true;
}

// ---------- reviews ----------
export function listReviews() {
  if (!existsSync(REVIEWS_DIR)) return [];
  return readdirSync(REVIEWS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJSON(join(REVIEWS_DIR, f), null))
    .filter(Boolean);
}

export function getReview(id) {
  return existsSync(reviewPath(id)) ? readJSON(reviewPath(id), null) : null;
}

/** Resolve a review; for reject, compile its version's comments into the reason. */
export function resolveReview(id, decision) {
  const review = getReview(id);
  if (!review) return null;
  review.status = decision === "approve" ? "approved" : "rejected";
  review.resolvedAt = now();
  if (decision === "reject") review.reason = compileReason(review.projectKey, review.version);
  writeFileSync(reviewPath(id), enc(review));
  return review;
}

function compileReason(key, n) {
  const comments = listComments(key, n);
  const lineComments = comments.filter((c) => c.line != null).sort((a, b) => a.line - b.line);
  const general = comments.filter((c) => c.line == null);
  const md = getVersion(key, n)?.markdown ?? "";
  const lines = md.split("\n");

  const parts = [
    "The reviewer requested changes to this plan in the plan-review UI. " +
      "Address each comment below, then re-present the revised plan with ExitPlanMode.",
  ];
  if (lineComments.length) {
    parts.push("\nLine comments:");
    for (const c of lineComments) {
      const s = c.line;
      const e = c.lineEnd ?? s;
      const label = e !== s ? `lines ${s}-${e}` : `line ${s}`;
      const snippet = lines
        .slice(s - 1, e)
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 3)
        .join(" / ");
      parts.push(`- [${label}] "${snippet}"\n    → ${c.body}`);
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
