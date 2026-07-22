import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  writeSync,
  existsSync,
  rmSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  PROJECTS_DIR,
  REVIEWS_DIR,
  docPath,
  manifestPath,
  projectDir,
  projectKey,
  versionDir,
} from "./paths.js";

/** Auto-rejection reason written when a pending review is force-deleted in the UI. */
const DELETE_REASON =
  "This plan was deleted in the review UI — re-present or ask the user how to proceed";

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

// ---------- double-fire dedup (one ExitPlanMode call → one review) ----------
// Two hook entries in different settings scopes can both fire for the SAME
// ExitPlanMode tool call; they arrive with an identical tool_use_id. We serialize
// them with an exclusive-create marker file keyed by tool_use_id: the first
// process to create the marker "wins" and records the review, writing its id back
// into the marker; concurrent losers read that id and reuse the review instead of
// creating a duplicate. The marker uses a NON-.json extension so it's invisible to
// listReviews() (which globs *.json). Fail-open: any error skips dedup.
const toolUseMarkerPath = (id) =>
  join(REVIEWS_DIR, `tooluse-${String(id).replace(/[^a-zA-Z0-9_-]/g, "_")}.lock`);

/** Synchronous sleep (recordPlan is sync, called from the blocking hook). */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // SharedArrayBuffer unavailable → best-effort busy wait
    const end = Date.now() + ms;
    while (Date.now() < end) {}
  }
}

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

/** Canonical content hash for dedup — stable across both creation paths. */
function hashTree(tree) {
  if (tree.kind === "tree") {
    const recs = [...tree.docs]
      .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
      .map((d) => `${d.slug} ${d.title} ${d.parent || ""} ${d.body}`);
    return sha(recs.join("  "));
  }
  return sha(tree.markdown ?? "");
}

/** Persist a tree version: manifest.json + one <slug>.md per doc. */
function writeTree(key, version, tree) {
  mkdirSync(versionDir(key, version), { recursive: true });
  const docs = tree.docs.map((d) => {
    const file = `${d.slug}.md`;
    writeFileSync(docPath(key, version, file), d.body ?? "");
    return { slug: d.slug, title: d.title, parent: d.parent ?? null, file, order: d.order };
  });
  writeFileSync(manifestPath(key, version), enc({ schema: 1, root: tree.root || "root", docs }));
}

/**
 * Record a freshly-presented plan. De-dupes by content hash: an identical
 * re-presentation reuses the existing version (and keeps its comments),
 * otherwise a new immutable version is written. Always creates a new review.
 *
 * Takes a normalized `tree` (parsePlan output — {kind:"single",markdown} or
 * {kind:"tree",root,docs}); a legacy `plan` string is accepted as a single doc.
 */
export function recordPlan(opts) {
  const key = projectKey(opts.cwd);
  ensureDirs(key);

  // Double-fire dedup: if another invocation with the same tool_use_id is already
  // in flight (or done), reuse its review rather than creating a second one.
  let markerFd = null;
  const markerFile = opts.toolUseId ? toolUseMarkerPath(opts.toolUseId) : null;
  if (markerFile) {
    try {
      markerFd = openSync(markerFile, "wx"); // atomic exclusive create — we won the race
    } catch (e) {
      if (e && e.code === "EEXIST") {
        // Someone else is recording (or has recorded) this tool call. Wait for
        // them to publish the reviewId, then reuse it.
        for (let i = 0; i < 120; i++) {
          const m = readJSON(markerFile, null);
          if (m && m.reviewId && existsSync(reviewPath(m.reviewId))) {
            return { key, version: m.version, reviewId: m.reviewId, reused: true };
          }
          sleepSync(50);
        }
        // Winner never published (crashed mid-write) → fall through and record our own.
      }
      // Any other error → skip dedup, record normally.
    }
  }

  const tree =
    opts.tree ?? { kind: "single", markdown: opts.plan != null ? opts.plan : "" };
  const hash = hashTree(tree);

  let meta = getProjectMeta(key);
  let version;

  if (meta && meta.latestHash === hash) {
    // identical plan re-presented → reuse latest version
    version = meta.currentVersion;
    meta.updatedAt = now();
  } else {
    version = (meta?.currentVersion ?? 0) + 1;
    const kind = tree.kind === "tree" ? "tree" : "single";
    const docCount = kind === "tree" ? tree.docs.length : 1;
    if (kind === "tree") writeTree(key, version, tree);
    else writeFileSync(versionMd(key, version), tree.markdown ?? "");
    writeFileSync(
      versionMeta(key, version),
      enc({
        n: version,
        createdAt: now(),
        sessionId: opts.sessionId,
        toolUseId: opts.toolUseId,
        hash,
        kind,
        docCount,
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
      // provenance of the submission: "hook" (plan-mode ExitPlanMode), "mcp"
      // (plan_review_submit tool) or "api" (POST /api/plans). Only mcp/api
      // reviews are gated by the Stop hook; missing ⇒ "hook" (never gated).
      origin: opts.origin || "hook",
      createdAt: now(),
    }),
  );

  // Publish the reviewId into the marker so any concurrent duplicate invocation
  // reuses it instead of creating a second review.
  if (markerFd !== null) {
    try {
      writeSync(markerFd, JSON.stringify({ toolUseId: opts.toolUseId, key, version, reviewId }));
    } catch {}
    try {
      closeSync(markerFd);
    } catch {}
  }

  return { key, version, reviewId, reused: false };
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
    // guard legacy metas that predate updatedAt
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

export function listVersions(key) {
  const dir = join(projectDir(key), "versions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJSON(join(dir, f), null))
    .filter(Boolean)
    // defaults for legacy metas (missing kind ⇒ single)
    .map((m) => ({ kind: "single", docCount: 1, ...m }))
    .sort((a, b) => a.n - b.n);
}

/** True when version n is stored as a tree (manifest present). */
function isTree(key, n) {
  return existsSync(manifestPath(key, n));
}

/**
 * Flatten a tree version into one markdown string — each doc's body preceded by
 * a title heading (level by depth), in manifest order. Feeds diff / gist save /
 * the flat comment-snippet fallback.
 */
function flattenManifest(key, n, manifest) {
  const bySlug = new Map(manifest.docs.map((d) => [d.slug, d]));
  const depth = (slug) => {
    let d = 0;
    let cur = bySlug.get(slug);
    const seen = new Set();
    while (cur && cur.parent && !seen.has(cur.slug)) {
      seen.add(cur.slug);
      d++;
      cur = bySlug.get(cur.parent);
    }
    return d;
  };
  const parts = [];
  for (const d of manifest.docs) {
    const h = "#".repeat(Math.min(6, depth(d.slug) + 1));
    const body = existsSync(docPath(key, n, d.file))
      ? readFileSync(docPath(key, n, d.file), "utf8")
      : "";
    // Skip the synthesized heading when the body already opens with a heading
    // whose text equals the doc title (avoids a duplicate "# Title").
    const first = body.split("\n").find((l) => l.trim());
    const firstHeading = first && first.match(/^\s*#{1,6}\s+(.+?)\s*$/);
    const chunk =
      firstHeading && firstHeading[1].trim() === String(d.title).trim()
        ? body
        : `${h} ${d.title}\n\n${body}`;
    parts.push(chunk.replace(/\s+$/, ""));
  }
  return parts.join("\n\n");
}

export function getVersion(key, n) {
  if (isTree(key, n)) {
    const manifest = readJSON(manifestPath(key, n), null);
    if (!manifest) return null;
    return {
      kind: "tree",
      meta: readJSON(versionMeta(key, n), { n, createdAt: "", hash: "", kind: "tree" }),
      manifest,
      markdown: flattenManifest(key, n, manifest),
    };
  }
  if (!existsSync(versionMd(key, n))) return null;
  return {
    kind: "single",
    markdown: readFileSync(versionMd(key, n), "utf8"),
    meta: readJSON(versionMeta(key, n), { n, createdAt: "", hash: "", kind: "single" }),
  };
}

/** Return the doc manifest; single-doc versions synthesize a single root doc. */
export function getManifest(key, n) {
  if (isTree(key, n)) return readJSON(manifestPath(key, n), null);
  if (!existsSync(versionMd(key, n))) return null;
  const md = readFileSync(versionMd(key, n), "utf8");
  const h1 = md.match(/^\s*#\s+(.+?)\s*$/m);
  return {
    schema: 1,
    root: "root",
    docs: [{ slug: "root", title: h1 ? h1[1].trim() : "Overview", parent: null, file: `${pad(n)}.md`, order: 0 }],
  };
}

/** One document's content; single-doc "root" resolves to the flat markdown. */
export function getDoc(key, n, slug) {
  if (isTree(key, n)) {
    const manifest = readJSON(manifestPath(key, n), null);
    const d = manifest?.docs.find((x) => x.slug === slug);
    if (!d) return null;
    const md = existsSync(docPath(key, n, d.file)) ? readFileSync(docPath(key, n, d.file), "utf8") : "";
    return { slug: d.slug, title: d.title, parent: d.parent ?? null, markdown: md };
  }
  if (slug !== "root" || !existsSync(versionMd(key, n))) return null;
  const md = readFileSync(versionMd(key, n), "utf8");
  const h1 = md.match(/^\s*#\s+(.+?)\s*$/m);
  return { slug: "root", title: h1 ? h1[1].trim() : "Overview", parent: null, markdown: md };
}

// ---------- comments ----------
function readComments(key, n) {
  return readJSON(commentsPath(key, n), []);
}

export function listComments(key, n, doc) {
  // legacy comments predate `doc` → default to "root"
  const all = readComments(key, n).map((c) => ({ ...c, doc: c.doc || "root" }));
  return doc == null ? all : all.filter((c) => c.doc === doc);
}

export function addComment(key, n, c) {
  const comments = readComments(key, n);
  const comment = {
    id: randomBytes(6).toString("hex"),
    doc: c.doc || "root",
    line: c.line,
    lineEnd: c.line == null ? null : (c.lineEnd ?? c.line),
    // the exact rendered text the reviewer selected in the preview (if any) —
    // quoted back to Claude verbatim, which is more precise than a line slice.
    quote: c.quote ? String(c.quote).slice(0, 2000) : null,
    body: c.body,
    author: c.author || "me",
    createdAt: now(),
  };
  comments.push(comment);
  writeFileSync(commentsPath(key, n), enc(comments));
  return comment;
}

export function deleteComment(key, n, id) {
  const comments = readComments(key, n);
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

/**
 * Resolve a review.
 *   - reject  → compile the version's comments into `reason` (fed back via deny).
 *   - approve → if the version has comments, compile them into `notes`
 *               (delivered to Claude as additionalContext on the allow — "approve with comments").
 * Returns the review including `commentCount` so callers can reflect it in the UI.
 */
export function resolveReview(id, decision) {
  const review = getReview(id);
  if (!review) return null;
  review.status = decision === "approve" ? "approved" : "rejected";
  review.resolvedAt = now();
  review.commentCount = listComments(review.projectKey, review.version).length;
  if (decision === "reject") {
    review.reason = compileComments(review.projectKey, review.version, "reject");
  } else {
    const notes = compileComments(review.projectKey, review.version, "approve");
    if (notes) review.notes = notes;
  }
  writeFileSync(reviewPath(id), enc(review));
  return review;
}

/**
 * Format a version's comments for the model, grouped per document (labeled by
 * doc title when the plan is a tree). Line snippets are read from THAT doc's own
 * markdown, not the flattened blob.
 *   mode "reject"  → "address these, then re-present" (always returns text, even with no comments).
 *   mode "approve" → "plan is approved, incorporate these notes" (returns "" when there are none).
 */
function compileComments(key, n, mode) {
  const all = listComments(key, n);
  const anyLine = all.some((c) => c.line != null);
  const anyGeneral = all.some((c) => c.line == null);

  if (mode === "approve" && !anyLine && !anyGeneral) return "";

  const manifest = getManifest(key, n);
  const orderOf = new Map();
  const titleOf = new Map();
  for (const d of manifest?.docs ?? []) {
    orderOf.set(d.slug, d.order ?? 0);
    titleOf.set(d.slug, d.title);
  }

  const parts = [
    mode === "approve"
      ? "The reviewer APPROVED this plan in the plan-review UI and left the notes below. " +
        "Proceed with implementation, incorporating each note as you go."
      : "The reviewer requested changes to this plan in the plan-review UI. " +
        "Address each comment below, then re-present the revised plan with ExitPlanMode.",
  ];

  const docSlugs = [...new Set(all.map((c) => c.doc))].sort(
    (a, b) => (orderOf.get(a) ?? 1e9) - (orderOf.get(b) ?? 1e9) || (a < b ? -1 : a > b ? 1 : 0),
  );
  const multi = docSlugs.length > 1;

  for (const slug of docSlugs) {
    const docComments = all.filter((c) => c.doc === slug);
    const lineComments = docComments.filter((c) => c.line != null).sort((a, b) => a.line - b.line);
    const general = docComments.filter((c) => c.line == null);
    if (!lineComments.length && !general.length) continue;

    const lines = (getDoc(key, n, slug)?.markdown ?? "").split("\n");

    if (multi) parts.push(`\n## ${titleOf.get(slug) || slug}`);
    if (lineComments.length) {
      parts.push("\nLine comments:");
      for (const c of lineComments) {
        const s = c.line;
        const e = c.lineEnd ?? s;
        const label = e !== s ? `lines ${s}-${e}` : `line ${s}`;
        // Prefer the reviewer's actual selected text; fall back to the source lines.
        const snippet = c.quote
          ? c.quote.replace(/\s+/g, " ").trim().slice(0, 300)
          : lines
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
  }

  if (mode === "reject" && !anyLine && !anyGeneral) {
    parts.push("\n(No specific comments were left — please reconsider and improve the plan.)");
  }
  return parts.join("\n");
}

// ---------- deletion ----------
/** Remove every on-disk artifact for one version (flat file, tree dir, comments). */
function removeVersionFiles(key, n) {
  for (const path of [versionMd(key, n), versionMeta(key, n), commentsPath(key, n)]) {
    try {
      rmSync(path, { force: true });
    } catch {}
  }
  try {
    rmSync(versionDir(key, n), { recursive: true, force: true });
  } catch {}
}

/**
 * Recompute a project's meta after deletions.
 *   currentVersion = max surviving version; latestHash = that meta's stored hash.
 *   Unparsable metas are skipped; latestHash is never set to "".
 *   Zero versions left ⇒ the whole project dir is removed and null is returned.
 */
export function recomputeMeta(key) {
  const versions = listVersions(key); // parseable metas only, sorted asc
  if (!versions.length) {
    try {
      rmSync(projectDir(key), { recursive: true, force: true });
    } catch {}
    return null;
  }
  const meta = getProjectMeta(key);
  if (!meta) return null;
  const latest = versions[versions.length - 1];
  meta.currentVersion = latest.n;
  if (latest.hash) meta.latestHash = latest.hash; // never blank it out
  meta.updatedAt = now();
  writeFileSync(metaPath(key), enc(meta));
  return meta;
}

/**
 * Delete a single version. A pending review blocks the delete unless force, in
 * which case the review is force-rejected first (a live polling hook then
 * unblocks via its normal deny path).
 */
export function deleteVersion(key, n, opts = {}) {
  const force = !!opts.force;
  const pending = listPendingReviews(key, n);
  if (pending.length && !force) {
    return { deleted: false, blocked: true, meta: getProjectMeta(key), pendingReviews: pending };
  }
  for (const r of pending) rejectReviewForced(r.id, DELETE_REASON);
  removeVersionFiles(key, n);
  return { deleted: true, blocked: false, meta: recomputeMeta(key) };
}

/** Delete an entire project (all versions + its reviews). */
export function deleteProject(key, opts = {}) {
  const force = !!opts.force;
  const pending = listPendingReviews(key);
  if (pending.length && !force) {
    return { deleted: false, blocked: true, meta: getProjectMeta(key), pendingReviews: pending };
  }
  for (const r of pending) rejectReviewForced(r.id, DELETE_REASON);
  try {
    rmSync(projectDir(key), { recursive: true, force: true });
  } catch {}
  deleteReviewsForProject(key);
  return { deleted: true, blocked: false, meta: null };
}

// ---------- review helpers ----------
export function listPendingReviews(key, n) {
  return listReviews().filter(
    (r) => r.projectKey === key && r.status === "pending" && (n == null || r.version === n),
  );
}

/** Force-reject a review with a fixed reason (does not touch version files). */
export function rejectReviewForced(id, reason) {
  const review = getReview(id);
  if (!review) return null;
  review.status = "rejected";
  review.resolvedAt = now();
  review.reason = reason;
  review.forced = true;
  writeFileSync(reviewPath(id), enc(review));
  return review;
}

export function deleteReviewsForProject(key) {
  for (const r of listReviews()) {
    if (r.projectKey === key) {
      try {
        rmSync(reviewPath(r.id), { force: true });
      } catch {}
    }
  }
}

export function deleteReviewsForVersion(key, n) {
  for (const r of listReviews()) {
    if (r.projectKey === key && r.version === n) {
      try {
        rmSync(reviewPath(r.id), { force: true });
      } catch {}
    }
  }
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
