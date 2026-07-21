/**
 * Pure, dependency-free parser for multi-document plans.
 *
 * A plan is a single markdown string. Documents are delimited by an HTML-comment
 * marker, alone on its own line (invisible when rendered as plain markdown):
 *
 *   <!--doc slug=root title="Overview"-->
 *   <!--doc slug=api title="API Design" parent=root-->
 *
 * Zero markers ⇒ a single flat document (stored exactly as today). Content before
 * the first marker becomes the root document. The scan is fence-aware: marker
 * lines inside fenced code blocks (``` or ~~~) are ignored.
 */

const MARKER_RE = /^\s*<!--doc\s+(.*?)\s*-->\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Parse `key=value` / `key="quoted value"` pairs, order-independent. */
function parseAttrs(str) {
  const attrs = {};
  const re = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let m;
  while ((m = re.exec(str))) {
    attrs[m[1]] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return attrs;
}

/** Normalize a parent attribute → parent slug, or null for a top-level doc. */
function normParent(parent, slug) {
  if (parent == null) return null;
  const v = String(parent).trim();
  if (v === "" || v === slug) return null;
  return v;
}

/** Cross-doc link targets referenced from a doc body. */
function linkTargets(body) {
  const s = String(body || "");
  const out = [];
  let m;
  const wiki = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
  while ((m = wiki.exec(s))) out.push(m[1].trim());
  const md = /\]\(doc:([^)\s]+)\)/g;
  while ((m = md.exec(s))) out.push(m[1].trim());
  return out;
}

/**
 * Validate a document set, collecting ALL issues. Also used for pre-structured
 * docs coming from POST /api/plans. Returns Issue[] ({code,message,marker?}).
 */
export function validateDocs(docs) {
  const list = Array.isArray(docs) ? docs : [];
  const issues = [];
  const withMarker = (i, d) => (d && d.marker ? { ...i, marker: d.marker } : i);

  const slugSet = new Set();
  const seen = new Set();
  const dupReported = new Set();

  for (const d of list) {
    const slug = d.slug == null ? "" : String(d.slug);
    if (!slug) {
      issues.push(
        withMarker(
          { code: "missing-slug", message: `A document is missing its \`slug\`${d.title ? ` (title "${d.title}")` : ""}.` },
          d,
        ),
      );
    } else {
      if (!SLUG_RE.test(slug)) {
        issues.push(
          withMarker({ code: "bad-slug", message: `Slug "${slug}" is invalid — use kebab-case matching ^[a-z0-9][a-z0-9-]*$.` }, d),
        );
      }
      if (seen.has(slug) && !dupReported.has(slug)) {
        issues.push(withMarker({ code: "duplicate-slug", message: `Slug "${slug}" is used by more than one document.` }, d));
        dupReported.add(slug);
      }
      seen.add(slug);
      slugSet.add(slug);
    }
    if (!d.title || !String(d.title).trim()) {
      issues.push(withMarker({ code: "missing-title", message: `Document "${slug || "(no slug)"}" is missing its \`title\`.` }, d));
    }
  }

  // exactly one root (top-level doc with no parent)
  const roots = list.filter((d) => normParent(d.parent, d.slug) === null);
  if (roots.length === 0) {
    issues.push({ code: "no-root", message: "No root document — exactly one document must have no parent." });
  } else if (roots.length > 1) {
    issues.push({
      code: "multiple-roots",
      message: `Multiple root documents (${roots.map((d) => d.slug || "?").join(", ")}) — exactly one document may have no parent.`,
    });
  }

  // unknown parents
  for (const d of list) {
    const p = normParent(d.parent, d.slug);
    if (p !== null && !slugSet.has(p)) {
      issues.push(withMarker({ code: "unknown-parent", message: `Document "${d.slug}" references unknown parent "${p}".` }, d));
    }
  }

  // parent cycles
  const bySlug = new Map(list.filter((d) => d.slug).map((d) => [String(d.slug), d]));
  const cycled = new Set();
  for (const d of list) {
    if (!d.slug) continue;
    const visited = new Set();
    let cur = d;
    while (cur) {
      const s = String(cur.slug);
      if (visited.has(s)) {
        cycled.add(s);
        break;
      }
      visited.add(s);
      const p = normParent(cur.parent, cur.slug);
      if (p === null) break;
      cur = bySlug.get(p);
    }
  }
  for (const s of cycled) {
    issues.push({ code: "parent-cycle", message: `Document "${s}" is part of a parent cycle.` });
  }

  // dangling cross-doc links
  for (const d of list) {
    for (const target of linkTargets(d.body)) {
      if (!slugSet.has(target)) {
        issues.push(
          withMarker({ code: "dangling-link", message: `Document "${d.slug}" links to "${target}", which is not a defined slug.` }, d),
        );
      }
    }
  }

  return issues;
}

/**
 * Parse a plan string.
 *   → {kind:"single", markdown}
 *   → {kind:"tree", root, docs:[{slug,title,parent|null,body,order}]}
 *   → {error:{issues:[{code,message,marker?}]}}
 */
export function parsePlan(planString) {
  const src = String(planString ?? "");
  const lines = src.split("\n");

  let inFence = false;
  const markers = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = MARKER_RE.exec(line);
    if (m) markers.push({ attrs: parseAttrs(m[1]), line: i, raw: line.trim() });
  }

  if (markers.length === 0) {
    return { kind: "single", markdown: src };
  }

  const docs = [];
  let order = 0;

  // content before the first marker → root document
  const preContent = lines.slice(0, markers[0].line).join("\n");
  if (preContent.trim()) {
    const h1 = preContent.match(/^\s*#\s+(.+?)\s*$/m);
    docs.push({
      slug: "root",
      title: h1 ? h1[1].trim() : "Overview",
      parent: null,
      body: preContent.replace(/\s+$/, ""),
      order: order++,
    });
  }

  for (let k = 0; k < markers.length; k++) {
    const { attrs, line, raw } = markers[k];
    const bodyStart = line + 1;
    const bodyEnd = k + 1 < markers.length ? markers[k + 1].line : lines.length;
    const body = lines.slice(bodyStart, bodyEnd).join("\n").replace(/\s+$/, "");
    docs.push({
      slug: attrs.slug,
      title: attrs.title,
      parent: normParent(attrs.parent, attrs.slug),
      body,
      order: order++,
      marker: raw,
    });
  }

  const issues = validateDocs(docs);
  if (issues.length) return { error: { issues } };

  const root = docs.find((d) => d.parent === null);
  return {
    kind: "tree",
    root: root ? root.slug : "root",
    docs: docs.map((d) => ({ slug: d.slug, title: d.title, parent: d.parent, body: d.body, order: d.order })),
  };
}

/** Rewrite '[[slug]]' / '[[slug|text]]' wiki links to '[text](doc:slug)' (pre-lex step). */
export function rewriteWikiLinks(md) {
  return String(md ?? "").replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_, slug, text) => {
    const s = String(slug).trim();
    const t = text != null && String(text).trim() ? String(text).trim() : s;
    return `[${t}](doc:${s})`;
  });
}

/** Build the verbatim deny-reason the hook feeds back on a malformed tree. */
export function buildDenyReason(issues) {
  const lines = [
    "Your multi-document plan has structural problems. Fix them and re-present with ExitPlanMode.",
    "",
    "Marker format — one HTML comment per document, on its own line:",
    '  <!--doc slug=<kebab-case-id> title="Human Title" parent=<parent-slug>-->',
    "Rules: exactly one root doc (no parent); every slug unique; every parent must",
    "exist; cross-doc links use [[slug]] or [text](doc:slug) and must target a defined slug.",
    "",
    "Problems found:",
  ];
  for (const it of Array.isArray(issues) ? issues : []) lines.push(`  • ${it.message}`);
  return lines.join("\n");
}
