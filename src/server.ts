import { marked } from "marked";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PORT, ROOT, SERVER_FILE } from "./paths.ts";
import {
  addComment,
  deleteComment,
  getProjectMeta,
  getReview,
  getVersion,
  listComments,
  listProjects,
  listReviews,
  listVersions,
  pruneResolvedReviews,
  resolveReview,
} from "./store.ts";

const UI_DIR = join(import.meta.dir, "ui");

marked.setOptions({ gfm: true, breaks: false });

function renderMarkdown(md: string): string {
  const html = marked.parse(md, { async: false }) as string;
  // light sanitization — local tool, content authored by your own Claude session
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

async function serveStatic(name: string): Promise<Response> {
  const file = Bun.file(join(UI_DIR, name));
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  const ext = name.slice(name.lastIndexOf("."));
  return new Response(file, {
    headers: { "content-type": CONTENT_TYPES[ext] || "application/octet-stream" },
  });
}

export function startServer(port = DEFAULT_PORT) {
  mkdirSync(ROOT, { recursive: true });
  pruneResolvedReviews();

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      port,
      idleTimeout: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const p = url.pathname;
        const seg = p.split("/").filter(Boolean); // e.g. ["api","projects","KEY","versions","2"]

        // ---- static UI ----
        if (p === "/") return serveStatic("index.html");
        if (p === "/app.js") return serveStatic("app.js");
        if (p === "/style.css") return serveStatic("style.css");

        // ---- api ----
        if (seg[0] === "api") {
          try {
            return await handleApi(req, seg.slice(1), url);
          } catch (e: any) {
            return json({ error: String(e?.message || e) }, 500);
          }
        }
        return new Response("Not found", { status: 404 });
      },
    });
  } catch (e: any) {
    if (String(e?.message || e).includes("EADDRINUSE") || e?.code === "EADDRINUSE") {
      // another instance already owns the port — fine.
      console.log(`plan-review server already running on :${port}`);
      process.exit(0);
    }
    throw e;
  }

  writeFileSync(
    SERVER_FILE,
    JSON.stringify({ port, pid: process.pid, startedAt: new Date().toISOString() }, null, 2),
  );
  const cleanup = () => {
    try {
      rmSync(SERVER_FILE, { force: true });
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  console.log(`plan-review server on http://localhost:${port}`);
  return server;
}

async function handleApi(req: Request, seg: string[], url: URL): Promise<Response> {
  const [a, b, c, d, e] = seg;

  if (a === "health") return json({ ok: true });

  if (a === "projects" && !b) return json(listProjects());

  if (a === "projects" && b && !c) {
    const meta = getProjectMeta(b);
    if (!meta) return json({ error: "no such project" }, 404);
    return json({ meta, versions: listVersions(b) });
  }

  // /api/projects/:key/diff?from=&to=
  if (a === "projects" && b && c === "diff") {
    const from = Number(url.searchParams.get("from"));
    const to = Number(url.searchParams.get("to"));
    return json({
      from: { n: from, markdown: getVersion(b, from)?.markdown ?? "" },
      to: { n: to, markdown: getVersion(b, to)?.markdown ?? "" },
    });
  }

  // /api/projects/:key/versions/:n ...
  if (a === "projects" && b && c === "versions" && d) {
    const key = b;
    const n = Number(d);
    if (!e) {
      const v = getVersion(key, n);
      if (!v) return json({ error: "no such version" }, 404);
      return json({ n, markdown: v.markdown, html: renderMarkdown(v.markdown), meta: v.meta });
    }
    if (e === "comments") {
      if (req.method === "GET") return json(listComments(key, n));
      if (req.method === "POST") {
        const body = (await req.json()) as { line: number | null; body: string };
        if (!body.body?.trim()) return json({ error: "empty comment" }, 400);
        return json(addComment(key, n, { line: body.line ?? null, body: body.body.trim() }));
      }
    }
  }

  // /api/projects/:key/versions/:n/comments/:id  (DELETE)
  if (a === "projects" && b && c === "versions" && d && e === "comments" && seg[5]) {
    if (req.method === "DELETE") {
      const ok = deleteComment(b, Number(d), seg[5]);
      return json({ ok });
    }
  }

  // /api/reviews ...
  if (a === "reviews" && !b) return json(listReviews());
  if (a === "reviews" && b === "pending")
    return json(listReviews().filter((r) => r.status === "pending"));
  if (a === "reviews" && b && !c) {
    const r = getReview(b);
    return r ? json(r) : json({ error: "no such review" }, 404);
  }
  if (a === "reviews" && b && c === "decision" && req.method === "POST") {
    const body = (await req.json()) as { decision: "approve" | "reject" };
    const r = resolveReview(b, body.decision);
    return r ? json(r) : json({ error: "no such review" }, 404);
  }

  return json({ error: "unknown endpoint" }, 404);
}

// run directly: `bun src/server.ts [port]`
if (import.meta.main) {
  startServer(Number(process.argv[2]) || DEFAULT_PORT);
}
