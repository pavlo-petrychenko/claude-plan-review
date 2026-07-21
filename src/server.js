import http from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import { DEFAULT_PORT, ROOT, SERVER_FILE } from "./paths.js";
import {
  addComment,
  deleteComment,
  deleteProject,
  deleteVersion,
  getDoc,
  getManifest,
  getProjectMeta,
  getReview,
  getStorage,
  getVersion,
  listComments,
  listProjects,
  listReviews,
  listVersions,
  pruneResolvedReviews,
  recordPlan,
  resolveReview,
  setStorage,
} from "./store.js";
import { parsePlan, rewriteWikiLinks, validateDocs } from "./plan-parse.js";
import { getChannel, listChannelStatus } from "./channels/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(HERE, "ui");
const pkg = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));

marked.setOptions({ gfm: true, breaks: false });

/**
 * Render markdown, wrapping each top-level block in a `.md-block` div that
 * carries its SOURCE line range (data-line-start / data-line-end). The browser
 * uses these to map a text selection made in the rendered preview back to
 * source line numbers, so comments stay line-anchored (same model the diff and
 * comment store already use) while the reviewer works entirely in the preview.
 *
 * With `opts` ({key, version, validSlugs}) cross-document links are rewritten so
 * they navigate inside the review UI instead of hitting the `doc:` pseudo-scheme:
 *   1. pre-lex — `[[slug]]`/`[[slug|text]]` become `[text](doc:slug)`;
 *   2. post-lex — every `link` token whose href starts `doc:` is rewritten to
 *      `?project=KEY&version=N&doc=SLUG` and its anchor tagged `data-doc="SLUG"`
 *      (the UI delegates clicks on `#preview a[data-doc]` to in-app nav).
 * Only slugs present in `validSlugs` are rewritten. Called with NO opts the
 * output is byte-identical to the plain single-document render.
 */
function renderMarkdown(md, opts) {
  let src = md || "";
  if (opts) src = rewriteWikiLinks(src); // step 1: pre-lex wiki-link normalization

  const tokens = marked.lexer(src);

  // step 2: rewrite `doc:` link tokens in place; remember href→slug so the
  // rendered anchors can be tagged with data-doc (walkTokens can't add attrs).
  const hrefToSlug = new Map();
  if (opts) {
    const validSlugs = opts.validSlugs ? new Set(opts.validSlugs) : null;
    marked.walkTokens(tokens, (tok) => {
      if (tok.type !== "link" || typeof tok.href !== "string" || !tok.href.startsWith("doc:")) {
        return;
      }
      const slug = tok.href.slice(4).trim();
      if (validSlugs && !validSlugs.has(slug)) return;
      const params = [`doc=${encodeURIComponent(slug)}`];
      if (opts.key != null) params.unshift(`version=${encodeURIComponent(opts.version)}`);
      if (opts.key != null) params.unshift(`project=${encodeURIComponent(opts.key)}`);
      const href = `?${params.join("&")}`;
      tok.href = href;
      // marked v14 leaves `&` literal in hrefs; register the escaped form too so
      // the tag step is robust to a renderer that HTML-escapes the attribute.
      hrefToSlug.set(href, slug);
      hrefToSlug.set(href.replace(/&/g, "&amp;"), slug);
    });
  }

  let offset = 0; // running char offset into `src`; token.raw values concatenate to src
  const out = [];
  for (const tok of tokens) {
    const raw = tok.raw || "";
    if (tok.type !== "space") {
      const before = src.slice(0, offset);
      const startLine = before.length ? before.split("\n").length : 1;
      const trimmed = raw.replace(/\s+$/, ""); // ignore trailing blank lines in the range
      const endLine = src.slice(0, offset + trimmed.length).split("\n").length;
      const one = [tok];
      one.links = tokens.links; // preserve reference-style link definitions
      let html = marked.parser(one);
      if (hrefToSlug.size) html = tagDocLinks(html, hrefToSlug);
      out.push(
        `<div class="md-block" data-line-start="${startLine}" data-line-end="${endLine}">${html}</div>`,
      );
    }
    offset += raw.length;
  }
  // light sanitization — local tool, content authored by your own Claude session
  return out.join("\n").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
}

/** Tag rewritten cross-doc anchors with `data-doc` (matched by exact href). */
function tagDocLinks(html, hrefToSlug) {
  return html.replace(/<a\s+href="([^"]*)"/g, (m, href) => {
    const slug = hrefToSlug.get(href);
    return slug ? `<a data-doc="${slug}" href="${href}"` : m;
  });
}

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function sendJSON(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

function sendStatic(res, name) {
  const file = join(UI_DIR, name);
  if (!existsSync(file)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  res.writeHead(200, { "content-type": CONTENT_TYPES[extname(name)] || "application/octet-stream" });
  res.end(readFileSync(file));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

export function startServer(port = DEFAULT_PORT) {
  mkdirSync(ROOT, { recursive: true });
  pruneResolvedReviews();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const p = url.pathname;
    const seg = p.split("/").filter(Boolean);
    try {
      if (p === "/") return sendStatic(res, "index.html");
      if (p === "/app.js") return sendStatic(res, "app.js");
      if (p === "/style.css") return sendStatic(res, "style.css");
      if (seg[0] === "api") return await handleApi(req, res, seg.slice(1), url);
      res.writeHead(404);
      res.end("Not found");
    } catch (e) {
      sendJSON(res, { error: String(e?.message || e) }, 500);
    }
  });

  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      // another instance already owns the port — fine.
      console.log(`plan-review server already running on :${port}`);
      process.exit(0);
    }
    throw e;
  });

  server.listen(port, () => {
    writeFileSync(
      SERVER_FILE,
      JSON.stringify({ port, pid: process.pid, startedAt: new Date().toISOString() }, null, 2),
    );
    console.log(`plan-review server on http://localhost:${port}`);
  });

  const cleanup = () => {
    try {
      rmSync(SERVER_FILE, { force: true });
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  return server;
}

async function handleApi(req, res, seg, url) {
  const [a, b, c, d, e] = seg;
  const method = req.method;

  if (a === "health") return sendJSON(res, { ok: true });
  if (a === "version") return sendJSON(res, { version: pkg.version });
  if (a === "channels" && !b) return sendJSON(res, listChannelStatus());

  if (a === "projects" && !b) return sendJSON(res, listProjects());

  if (a === "projects" && b && !c) {
    // DELETE /api/projects/:key?force= — whole project
    if (method === "DELETE") {
      if (!getProjectMeta(b)) return sendJSON(res, { error: "no such project" }, 404);
      const r = deleteProject(b, { force: isForce(url) });
      if (r.blocked)
        return sendJSON(res, { error: "pending review blocks deletion", pendingReviews: r.pendingReviews }, 409);
      return sendJSON(res, r);
    }
    const meta = getProjectMeta(b);
    if (!meta) return sendJSON(res, { error: "no such project" }, 404);
    return sendJSON(res, { meta, versions: listVersions(b) });
  }

  // POST /api/projects/:key/bulk-delete — sibling of `versions`, immune to the NaN trap.
  // ALWAYS 200 with partial success: {deleted:[n…], blocked:[{n,pendingReviews}…], meta}.
  // (Never 409 — that stays only on single-version DELETE and project DELETE.) Done per
  // version so a blocked one never stops the rest; force deletes blocked ones too.
  if (a === "projects" && b && c === "bulk-delete" && !d && method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const versions = Array.isArray(body.versions)
      ? body.versions.map(Number).filter(Number.isFinite)
      : [];
    if (!versions.length) return sendJSON(res, { error: "`versions` must be a non-empty array" }, 400);
    const force = !!body.force;
    const deleted = [];
    const blocked = [];
    for (const n of versions) {
      const r = deleteVersion(b, n, { force });
      if (r.deleted) deleted.push(n);
      else if (r.blocked) blocked.push({ n, pendingReviews: r.pendingReviews });
    }
    return sendJSON(res, { deleted, blocked, meta: getProjectMeta(b) });
  }

  // /api/projects/:key/diff?from=&to=&doc=  (doc-scoped; default root)
  if (a === "projects" && b && c === "diff") {
    const from = Number(url.searchParams.get("from"));
    const to = Number(url.searchParams.get("to"));
    const doc = url.searchParams.get("doc") || "root";
    const fromDoc = getDoc(b, from, doc);
    const toDoc = getDoc(b, to, doc);
    return sendJSON(res, {
      doc,
      fromMissing: !fromDoc,
      toMissing: !toDoc,
      from: { n: from, markdown: fromDoc?.markdown ?? "", missing: !fromDoc },
      to: { n: to, markdown: toDoc?.markdown ?? "", missing: !toDoc },
    });
  }

  // /api/projects/:key/storage  → current channel bindings
  if (a === "projects" && b && c === "storage" && !d) {
    return sendJSON(res, getStorage(b));
  }

  // /api/projects/:key/versions/:n ...
  if (a === "projects" && b && c === "versions" && d) {
    const key = b;
    const n = Number(d);
    if (!Number.isFinite(n)) return sendJSON(res, { error: "bad version number" }, 400);

    // /api/projects/:key/versions/:n  (GET metadata | DELETE the version)
    if (!e) {
      if (method === "DELETE") {
        const r = deleteVersion(key, n, { force: isForce(url) });
        if (r.blocked)
          return sendJSON(res, { error: "pending review blocks deletion", pendingReviews: r.pendingReviews }, 409);
        return sendJSON(res, r);
      }
      if (method === "GET") {
        const v = getVersion(key, n);
        if (!v) return sendJSON(res, { error: "no such version" }, 404);
        const payload = { n, kind: v.kind, meta: v.meta, manifest: getManifest(key, n) };
        if (v.kind === "single") {
          payload.markdown = v.markdown;
          payload.html = renderMarkdown(v.markdown);
        }
        return sendJSON(res, payload);
      }
      return sendJSON(res, { error: "method not allowed" }, 405);
    }

    // /api/projects/:key/versions/:n/docs/:slug  (GET one rendered document)
    if (e === "docs" && seg[5] && method === "GET") {
      const doc = getDoc(key, n, seg[5]);
      if (!doc) return sendJSON(res, { error: "no such doc" }, 404);
      const validSlugs = (getManifest(key, n)?.docs ?? []).map((x) => x.slug);
      return sendJSON(res, {
        slug: doc.slug,
        title: doc.title,
        parent: doc.parent,
        markdown: doc.markdown,
        html: renderMarkdown(doc.markdown, { key, version: n, validSlugs }),
      });
    }

    // /api/projects/:key/versions/:n/comments  (GET ?doc= filtered | POST)
    if (e === "comments" && !seg[5]) {
      if (method === "GET") {
        const doc = url.searchParams.get("doc");
        return sendJSON(res, listComments(key, n, doc == null ? undefined : doc));
      }
      if (method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}");
        if (!body.body?.trim()) return sendJSON(res, { error: "empty comment" }, 400);
        return sendJSON(
          res,
          addComment(key, n, {
            doc: body.doc || "root",
            line: body.line ?? null,
            lineEnd: body.lineEnd ?? null,
            quote: body.quote ?? null,
            body: body.body.trim(),
          }),
        );
      }
    }
    // /api/projects/:key/versions/:n/comments/:id  (DELETE)
    if (e === "comments" && seg[5] && method === "DELETE") {
      return sendJSON(res, { ok: deleteComment(key, n, seg[5]) });
    }
    // /api/projects/:key/versions/:n/save  (POST) → push this version to a storage channel
    if (e === "save" && method === "POST") {
      return await handleSave(req, res, key, n);
    }
  }

  // POST /api/plans — tools-first plan creation (same store path as the hook)
  if (a === "plans" && !b && method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    return handleCreatePlan(res, body, url);
  }

  // /api/reviews ...
  if (a === "reviews" && !b) return sendJSON(res, listReviews());
  if (a === "reviews" && b === "pending")
    return sendJSON(res, listReviews().filter((r) => r.status === "pending"));
  if (a === "reviews" && b && !c) {
    const r = getReview(b);
    return r ? sendJSON(res, r) : sendJSON(res, { error: "no such review" }, 404);
  }
  if (a === "reviews" && b && c === "decision" && method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const r = resolveReview(b, body.decision);
    return r ? sendJSON(res, r) : sendJSON(res, { error: "no such review" }, 404);
  }

  return sendJSON(res, { error: "unknown endpoint" }, 404);
}

/** True when a `?force=` query flag is present and not explicitly falsey. */
function isForce(url) {
  if (!url.searchParams.has("force")) return false;
  const v = url.searchParams.get("force");
  return v !== "false" && v !== "0";
}

/**
 * Normalize a parent attribute → parent slug, or null for a top-level doc.
 * Mirrors plan-parse/mcp's normParent (absent/""/"root"/self ⇒ top-level) so a
 * `docs`-array POST stores an identical tree to the marker-parsed path.
 */
function normParent(parent, slug) {
  if (parent == null) return null;
  const v = String(parent).trim();
  if (v === "" || v === "root" || v === slug) return null;
  return v;
}

/** Turn a caller-supplied docs array into the store's tree shape. */
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

/**
 * POST /api/plans — record a plan and open a review WITHOUT the hook. Accepts
 * exactly one of `docs` (structured tree), `markdown` (single doc), or `plan`
 * (raw marker string the server parses). Records through the SAME `recordPlan`
 * the hook uses, so store shapes are identical. 201 {key,version,reviewId,
 * reviewUrl} on success; 400 {error, issues?} on a malformed plan.
 */
async function handleCreatePlan(res, body, url) {
  const cwd = body?.cwd;
  if (typeof cwd !== "string" || !cwd.trim()) {
    return sendJSON(res, { error: "`cwd` is required (absolute project path)." }, 400);
  }
  const provided = ["docs", "markdown", "plan"].filter(
    (k) => body[k] !== undefined && body[k] !== null,
  );
  if (provided.length !== 1) {
    return sendJSON(
      res,
      {
        error: provided.length
          ? `Provide exactly one content field — got ${provided.join(", ")}. Use only one of docs / markdown / plan.`
          : "Provide exactly one of `docs`, `markdown`, or `plan`.",
      },
      400,
    );
  }

  let tree;
  if (provided[0] === "docs") {
    if (!Array.isArray(body.docs) || body.docs.length === 0) {
      return sendJSON(res, { error: "`docs` must be a non-empty array of {slug, title, parent?, body}." }, 400);
    }
    const issues = validateDocs(body.docs);
    if (issues.length) return sendJSON(res, { error: "The plan documents are invalid.", issues }, 400);
    tree = docsToTree(body.docs);
  } else {
    const str = body[provided[0]];
    if (typeof str !== "string" || !str.trim()) {
      return sendJSON(res, { error: `\`${provided[0]}\` must be a non-empty string.` }, 400);
    }
    let parsed;
    try {
      parsed = parsePlan(str);
    } catch (err) {
      return sendJSON(res, { error: `Could not parse the plan: ${String(err?.message || err)}` }, 400);
    }
    if (parsed.error) return sendJSON(res, { error: "The plan documents are invalid.", issues: parsed.error.issues }, 400);
    tree = parsed;
  }

  let recorded;
  try {
    recorded = recordPlan({ cwd, tree, origin: "api" });
  } catch (err) {
    return sendJSON(res, { error: `Failed to record the plan: ${String(err?.message || err)}` }, 500);
  }
  const { key, version, reviewId } = recorded;
  const rootDoc = (tree && tree.root) || "root";
  const reviewUrl = `${url.origin}/?project=${encodeURIComponent(
    key,
  )}&version=${version}&review=${reviewId}&doc=${encodeURIComponent(rootDoc)}`;
  return sendJSON(res, { key, version, reviewId, reviewUrl }, 201);
}

/** POST /api/projects/:key/versions/:n/save — create or overwrite the channel's store. */
async function handleSave(req, res, key, n) {
  const body = JSON.parse((await readBody(req)) || "{}");
  const channelId = body.channel || "gist";
  const channel = getChannel(channelId);
  if (!channel) return sendJSON(res, { error: `unknown channel: ${channelId}` }, 400);

  const v = getVersion(key, n);
  if (!v) return sendJSON(res, { error: "no such version" }, 404);

  const ready = channel.available();
  if (!ready.ready) {
    return sendJSON(
      res,
      { error: ready.reason || "channel not ready", fixCommand: ready.fixCommand ?? null },
      409,
    );
  }

  const existing = getStorage(key)[channelId];
  try {
    const info = existing?.id
      ? channel.update({
          id: existing.id,
          markdown: v.markdown,
          description: body.description ?? existing.description ?? "",
          filename: body.filename ?? existing.filename,
          oldFilename: existing.filename,
        })
      : channel.create({
          markdown: v.markdown,
          description: body.description ?? "",
          filename: body.filename,
        });
    const saved = setStorage(key, channelId, { ...info, savedVersion: n });
    return sendJSON(res, { channel: channelId, savedVersion: n, ...saved });
  } catch (e) {
    return sendJSON(res, { error: String(e?.message || e), fixCommand: e?.fixCommand ?? null }, 502);
  }
}

// run directly: `node src/server.js [port]` (or bun)
const invokedDirectly =
  process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) startServer(Number(process.argv[2]) || DEFAULT_PORT);
