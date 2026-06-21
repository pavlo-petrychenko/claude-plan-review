import http from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import { DEFAULT_PORT, ROOT, SERVER_FILE } from "./paths.js";
import {
  addComment,
  deleteComment,
  getProjectMeta,
  getReview,
  getStorage,
  getVersion,
  listComments,
  listProjects,
  listReviews,
  listVersions,
  pruneResolvedReviews,
  resolveReview,
  setStorage,
} from "./store.js";
import { getChannel, listChannelStatus } from "./channels/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(HERE, "ui");
const pkg = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));

marked.setOptions({ gfm: true, breaks: false });

function renderMarkdown(md) {
  const html = marked.parse(md, { async: false });
  // light sanitization — local tool, content authored by your own Claude session
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
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
    const meta = getProjectMeta(b);
    if (!meta) return sendJSON(res, { error: "no such project" }, 404);
    return sendJSON(res, { meta, versions: listVersions(b) });
  }

  // /api/projects/:key/diff?from=&to=
  if (a === "projects" && b && c === "diff") {
    const from = Number(url.searchParams.get("from"));
    const to = Number(url.searchParams.get("to"));
    return sendJSON(res, {
      from: { n: from, markdown: getVersion(b, from)?.markdown ?? "" },
      to: { n: to, markdown: getVersion(b, to)?.markdown ?? "" },
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
    if (!e) {
      const v = getVersion(key, n);
      if (!v) return sendJSON(res, { error: "no such version" }, 404);
      return sendJSON(res, { n, markdown: v.markdown, html: renderMarkdown(v.markdown), meta: v.meta });
    }
    if (e === "comments" && !seg[5]) {
      if (method === "GET") return sendJSON(res, listComments(key, n));
      if (method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}");
        if (!body.body?.trim()) return sendJSON(res, { error: "empty comment" }, 400);
        return sendJSON(
          res,
          addComment(key, n, {
            line: body.line ?? null,
            lineEnd: body.lineEnd ?? null,
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
