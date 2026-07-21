"use strict";

const $ = (id) => document.getElementById(id);
const enc = encodeURIComponent;
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || res.statusText);
    err.status = res.status;
    err.body = body;
    err.fixCommand = body.fixCommand ?? null;
    err.pendingReviews = body.pendingReviews ?? null;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

const state = {
  key: null,
  version: null,
  baseVersion: null,
  reviewId: null,
  review: null,
  projects: [],
  versions: [],
  data: null, // { markdown, html, meta, kind?, manifest? }
  // --- multi-document ---
  manifest: null, // current version's manifest, or null for legacy/flat
  kind: "single",
  doc: "root", // active doc slug
  docCache: new Map(), // slug → {slug,title,parent,markdown,html}
  manifestCache: new Map(), // version n → manifest|null (for the diff doc union)
  allComments: [], // every comment on the version (each carries `doc`) — drives badges
  viewAsTree: false, // single-doc display-only outline mode
  treeSection: -1, // selected outline section index (-1 = show all)
  _sections: null, // cached outline sections for the current preview
  // --- deletion ---
  pendingDelete: null, // { type:"version"|"project"|"bulk", key, n?, ns?, fromManage? }
  manageProjects: null,
  // ---
  comments: [], // comments scoped to the active doc
  tab: "preview",
  diffMode: "split",
  pendingSel: null,
  pendingDoc: null, // &doc= from the initial URL, consumed once
  storage: {},
  channels: [],
};

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2600);
}

// ---------- bootstrap ----------
async function init() {
  const q = new URLSearchParams(location.search);
  state.key = q.get("project");
  state.reviewId = q.get("review");
  const wantV = q.get("version");
  state.pendingDoc = q.get("doc");

  wireUI();
  api("/api/version")
    .then((v) => ($("ver").textContent = "v" + v.version))
    .catch(() => {});
  await loadProjects();
  if (!state.projects.length) {
    showEmpty("No plans reviewed yet. Finish a plan in plan mode and it'll show up here.");
    pollLoop();
    return;
  }
  if (!state.key || !state.projects.some((p) => p.key === state.key)) state.key = state.projects[0].key;
  await selectProject(state.key, wantV ? Number(wantV) : null);
  pollLoop();
}

function showEmpty(msg) {
  document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
  $("panel-preview").classList.add("active");
  $("preview").innerHTML = `<div class="empty">${esc(msg)}</div>`;
  $("docSidebar").hidden = true;
  $("reviewActions").hidden = true;
  $("saveActions").hidden = true;
  $("deleteVerBtn").hidden = true;
  $("treeToggle").hidden = true;
}

async function loadProjects() {
  const projects = await api("/api/projects");
  state.projects = projects;
  const sel = $("projectSel");
  sel.innerHTML = projects
    .map(
      (p) =>
        `<option value="${esc(p.key)}">${esc(p.name)}${p.pending ? ` (${p.pending} pending)` : ""}</option>`,
    )
    .join("");
  if (state.key) sel.value = state.key;
}

async function selectProject(key, wantV) {
  state.key = key;
  $("projectSel").value = key;
  state.manifestCache = new Map();
  const { versions } = await api(`/api/projects/${enc(key)}`);
  state.versions = versions;
  state.storage = await api(`/api/projects/${enc(key)}/storage`).catch(() => ({}));
  if (!versions.length) {
    showEmpty("This project has no plan versions yet.");
    return;
  }
  const latest = versions.length ? versions[versions.length - 1].n : null;
  state.version = wantV || latest;

  const fmt = (v) => `v${v.n} · ${new Date(v.createdAt).toLocaleString()}${v.n === latest ? " (current)" : ""}`;
  $("versionSel").innerHTML = versions.map((v) => `<option value="${v.n}">${esc(fmt(v))}</option>`).join("");
  $("versionSel").value = String(state.version);
  $("deleteVerBtn").hidden = false;

  // base = the version right before current, if any
  state.baseVersion = versions.length > 1 ? versions[versions.findIndex((v) => v.n === state.version) - 1]?.n ?? versions[0].n : null;
  $("baseSel").innerHTML = versions
    .filter((v) => v.n !== state.version)
    .map((v) => `<option value="${v.n}">${esc(fmt(v))}</option>`)
    .join("");
  if (state.baseVersion) $("baseSel").value = String(state.baseVersion);

  await loadVersion(state.version);
}

async function loadVersion(n) {
  state.version = n;
  hideSelPop();
  state.viewAsTree = false;
  state.treeSection = -1;
  state.docCache = new Map();
  state.data = await api(`/api/projects/${enc(state.key)}/versions/${n}`);
  // Legacy/flat servers return no manifest — treat the whole plan as one root doc.
  state.manifest = state.data.manifest || null;
  const docs = state.manifest?.docs || [];
  const isTree = docs.length > 1;
  state.kind = state.data.kind || (isTree ? "tree" : "single");
  $("diffCur").textContent = n;
  updateTreeToggle();

  if (isTree) {
    // sidebar badge counts come from one unscoped fetch; threads filter it per doc.
    state.allComments = await api(`/api/projects/${enc(state.key)}/versions/${n}/comments`);
    let slug = state.manifest.root || docs[0].slug;
    if (state.pendingDoc && docs.some((d) => d.slug === state.pendingDoc)) slug = state.pendingDoc;
    state.pendingDoc = null;
    await loadDoc(slug);
  } else {
    state.doc = "root";
    state.comments = await api(`/api/projects/${enc(state.key)}/versions/${n}/comments`);
    state.allComments = state.comments;
    renderPreview();
    renderGeneral();
    updateCommentCount();
    renderSidebar();
  }

  refreshSaveUI();
  await refreshReview();
  if (state.tab === "diff") loadDiff();
}

// Load a document within a tree version (cached), scoping comments + preview to it.
async function loadDoc(slug) {
  state.doc = slug;
  hideSelPop();
  let doc = state.docCache.get(slug);
  if (!doc) {
    doc = await api(`/api/projects/${enc(state.key)}/versions/${state.version}/docs/${enc(slug)}`);
    state.docCache.set(slug, doc);
  }
  state.data = { ...state.data, markdown: doc.markdown, html: doc.html };
  state.comments = (state.allComments || []).filter((c) => (c.doc || "root") === slug);
  updateDocParam();
  renderPreview();
  renderGeneral();
  updateCommentCount();
  renderSidebar();
}

// keep &doc in the URL in sync without a reload (no pushState today — greenfield)
function updateDocParam() {
  const q = new URLSearchParams(location.search);
  if (state.key) q.set("project", state.key);
  if (state.version) q.set("version", String(state.version));
  if (state.doc && state.doc !== "root") q.set("doc", state.doc);
  else q.delete("doc");
  history.replaceState(null, "", location.pathname + "?" + q.toString());
}

// refetch comments after a create/delete, keeping the doc-scoped + badge views in sync
async function refreshComments() {
  state.allComments = await api(`/api/projects/${enc(state.key)}/versions/${state.version}/comments`);
  const isTree = state.manifest && state.manifest.docs.length > 1;
  state.comments = isTree
    ? state.allComments.filter((c) => (c.doc || "root") === state.doc)
    : state.allComments;
  renderPreview();
  renderGeneral();
  updateCommentCount();
  renderSidebar();
}

// ---------- rendering ----------
function renderPreview() {
  $("preview").innerHTML = state.data.html || "<p class='empty'>(empty plan)</p>";
  renderThreads();
  if (state.viewAsTree) applyTreeView();
}

// threads are anchored under the END line of their range; covered = every line a comment spans
function commentLayout() {
  const byAnchor = new Map();
  const covered = new Set();
  for (const c of state.comments) {
    if (c.line == null) continue;
    const s = c.line;
    const e = c.lineEnd ?? c.line;
    const anchor = Math.max(s, e);
    if (!byAnchor.has(anchor)) byAnchor.set(anchor, []);
    byAnchor.get(anchor).push(c);
    for (let k = s; k <= e; k++) covered.add(k);
  }
  return { byAnchor, covered };
}

function locLabel(c) {
  if (c.line == null) return "";
  const e = c.lineEnd ?? c.line;
  return e !== c.line ? `lines ${c.line}–${e}` : `line ${c.line}`;
}

function commentHTML(c) {
  const loc = locLabel(c);
  const quote = c.quote ? `<div class="cquote">${esc(c.quote)}</div>` : "";
  return `<div class="comment" data-id="${c.id}">
    <div class="chead"><span><b>${esc(c.author)}</b>${loc ? ` · <span class="loc">${loc}</span>` : ""} · ${new Date(c.createdAt).toLocaleString()}</span>
      <button class="del" data-del="${c.id}">delete</button></div>
    ${quote}
    <div class="cbody">${esc(c.body)}</div></div>`;
}

// map a source line to the rendered block that spans it
function blockForLine(line) {
  const blocks = $("preview").querySelectorAll(".md-block");
  for (const b of blocks) {
    if (Number(b.dataset.lineStart) <= line && line <= Number(b.dataset.lineEnd)) return b;
  }
  return blocks[blocks.length - 1] || null;
}

// render inline comment threads into the preview, anchored after their block
function renderThreads() {
  const preview = $("preview");
  preview.querySelectorAll(".threads, .composer.inline").forEach((n) => n.remove());
  const { byAnchor, covered } = commentLayout();

  preview.querySelectorAll(".md-block").forEach((b) => {
    const s = Number(b.dataset.lineStart);
    const e = Number(b.dataset.lineEnd);
    let has = false;
    for (let k = s; k <= e && !has; k++) if (covered.has(k)) has = true;
    b.classList.toggle("has-comments", has);
  });

  for (const [anchor, threads] of byAnchor) {
    const block = blockForLine(anchor);
    if (!block) continue;
    const box = document.createElement("div");
    box.className = "threads";
    box.innerHTML = threads.map(commentHTML).join("");
    block.after(box);
  }
}

function renderGeneral() {
  const gen = state.comments.filter((c) => c.line == null);
  $("generalList").innerHTML = gen.length ? gen.map(commentHTML).join("") : "";
}

function updateCommentCount() {
  const n = (state.allComments || state.comments).length;
  $("cCount").textContent = n ? n : "";
}

// ---------- sidebar (doc tree / outline) ----------
function docCounts() {
  const m = new Map();
  for (const c of state.allComments || []) {
    const d = c.doc || "root";
    m.set(d, (m.get(d) || 0) + 1);
  }
  return m;
}

function renderSidebar() {
  const sb = $("docSidebar");
  const isTree = state.manifest && state.manifest.docs.length > 1;
  if (isTree) {
    sb.hidden = false;
    sb.innerHTML = renderDocTree();
  } else if (state.viewAsTree) {
    sb.hidden = false;
    sb.innerHTML = renderHeadingTree();
  } else {
    sb.hidden = true;
    sb.innerHTML = "";
  }
}

function renderDocTree() {
  const docs = state.manifest.docs.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const bySlug = new Map(docs.map((d) => [d.slug, d]));
  const rootSlug = state.manifest.root || "root";
  const counts = docCounts();
  const pending = state.review && state.review.status === "pending";

  const parentKey = (d) => {
    const p = d.parent;
    if (!p || p === "") return d.slug === rootSlug ? null : rootSlug;
    return p;
  };

  const rows = [];
  const seen = new Set();
  const walk = (slug, depth) => {
    if (seen.has(slug)) return;
    const d = bySlug.get(slug);
    if (!d) return;
    seen.add(slug);
    rows.push(docRow(d, depth, counts, pending));
    docs.filter((x) => parentKey(x) === slug).forEach((ch) => walk(ch.slug, depth + 1));
  };
  walk(rootSlug, 0);
  // orphans (parent points nowhere) — render at top level so nothing is lost
  docs.forEach((d) => {
    if (!seen.has(d.slug)) walk(d.slug, 0);
  });

  return `<div class="sb-head">Documents</div>${rows.join("")}`;
}

function docRow(d, depth, counts, pending) {
  const n = counts.get(d.slug) || 0;
  const active = d.slug === state.doc ? " active" : "";
  const dot = n > 0 && pending ? `<span class="sb-dot" title="comments pending review"></span>` : "";
  const badge = n ? `<span class="sb-badge">${n}</span>` : "";
  return `<a class="sb-row${active}" data-doc="${esc(d.slug)}" href="#" style="padding-left:${8 + depth * 14}px">
    <span class="sb-title">${esc(d.title)}</span>${dot}${badge}</a>`;
}

// ---------- view-as-tree (single-doc, display-only) ----------
// Split the server-rendered preview into heading sections. Blocks are HIDDEN via
// a class, never detached — blockForLine/commentLayout still walk them by line.
function computeSections() {
  const blocks = [...$("preview").querySelectorAll(".md-block")];
  const sections = [];
  let cur = null;
  for (const b of blocks) {
    const first = b.firstElementChild;
    const isHeading = first && /^H[1-6]$/.test(first.tagName);
    if (isHeading) {
      cur = { id: sections.length, level: Number(first.tagName[1]), title: first.textContent.trim() || "(untitled)", blocks: [b] };
      sections.push(cur);
    } else {
      if (!cur) {
        cur = { id: sections.length, level: 0, title: "(top)", blocks: [] };
        sections.push(cur);
      }
      cur.blocks.push(b);
    }
  }
  return sections;
}

function applyTreeView() {
  const sections = computeSections();
  state._sections = sections;
  if (state.treeSection >= sections.length) state.treeSection = -1;
  const blocks = [...$("preview").querySelectorAll(".md-block")];

  const show = new Set();
  if (state.treeSection === -1) {
    blocks.forEach((b) => show.add(b));
  } else {
    const sel = sections[state.treeSection];
    sel.blocks.forEach((b) => show.add(b));
    if (sel.level !== 0) {
      for (let j = state.treeSection + 1; j < sections.length; j++) {
        if (sections[j].level > sel.level) sections[j].blocks.forEach((b) => show.add(b));
        else break;
      }
    }
  }
  blocks.forEach((b) => b.classList.toggle("tree-hidden", !show.has(b)));
  // hide threads whose owning block is hidden
  $("preview").querySelectorAll(".threads, .composer.inline").forEach((t) => {
    const prev = t.previousElementSibling;
    const hidden = prev && prev.classList.contains("md-block") && prev.classList.contains("tree-hidden");
    t.classList.toggle("tree-hidden", !!hidden);
  });
}

function renderHeadingTree() {
  const sections = state._sections || computeSections();
  state._sections = sections;
  const rows = [`<div class="sb-head">Outline</div>`];
  rows.push(
    `<a class="sb-row${state.treeSection === -1 ? " active" : ""}" data-sec="-1" href="#"><span class="sb-title">Show all</span></a>`,
  );
  sections.forEach((s, i) => {
    if (s.level === 0 && !s.blocks.length) return;
    const depth = s.level === 0 ? 0 : s.level - 1;
    rows.push(
      `<a class="sb-row${state.treeSection === i ? " active" : ""}" data-sec="${i}" href="#" style="padding-left:${8 + depth * 14}px"><span class="sb-title">${esc(s.title)}</span></a>`,
    );
  });
  return rows.join("");
}

function updateTreeToggle() {
  const isTree = state.manifest && state.manifest.docs.length > 1;
  const t = $("treeToggle");
  t.hidden = isTree; // real doc trees get the sidebar automatically
  if (isTree) state.viewAsTree = false;
  t.classList.toggle("active", state.viewAsTree);
  t.textContent = state.viewAsTree ? "Exit tree view" : "View as tree";
}

// ---------- comments ----------
async function addComment(line, lineEnd, body, quote) {
  if (!body.trim()) return;
  await api(`/api/projects/${enc(state.key)}/versions/${state.version}/comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ doc: state.doc, line, lineEnd, quote: quote ?? null, body }),
  });
  await refreshComments();
}

async function delComment(id) {
  await api(`/api/projects/${enc(state.key)}/versions/${state.version}/comments/${id}`, {
    method: "DELETE",
  });
  await refreshComments();
}

// ---------- text selection → line-anchored comment ----------
function currentSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const preview = $("preview");
  if (!preview.contains(range.commonAncestorContainer)) return null;
  const quote = sel.toString().replace(/\s+/g, " ").trim();
  if (!quote) return null;

  const blocks = [];
  preview.querySelectorAll(".md-block").forEach((b) => {
    if (b.classList.contains("tree-hidden")) return;
    const ir = range.cloneRange();
    const br = document.createRange();
    br.selectNodeContents(b);
    if (ir.compareBoundaryPoints(Range.START_TO_START, br) < 0) ir.setStart(br.startContainer, br.startOffset);
    if (ir.compareBoundaryPoints(Range.END_TO_END, br) > 0) ir.setEnd(br.endContainer, br.endOffset);
    if (!ir.collapsed && ir.toString().trim()) blocks.push(b);
  });
  if (!blocks.length) return null;
  const start = Math.min(...blocks.map((b) => Number(b.dataset.lineStart)));
  const end = Math.max(...blocks.map((b) => Number(b.dataset.lineEnd)));
  return { start, end, quote, rect: range.getBoundingClientRect() };
}

function showSelPop(info) {
  const pop = $("selPop");
  pop.hidden = false;
  pop.style.top = `${info.rect.bottom + 6}px`;
  pop.style.left = `${info.rect.left}px`;
  state.pendingSel = info;
}

function hideSelPop() {
  $("selPop").hidden = true;
  state.pendingSel = null;
}

function openComposer(info) {
  document.querySelector(".composer.inline")?.remove();
  const block = blockForLine(info.end);
  if (!block) return;
  const label = info.start === info.end ? `line ${info.start}` : `lines ${info.start}–${info.end}`;
  const box = document.createElement("div");
  box.className = "composer inline";
  box.innerHTML = `${info.quote ? `<div class="cquote">${esc(info.quote)}</div>` : ""}
    <div class="composer-row">
      <textarea placeholder="Comment on ${label}…"></textarea>
      <button class="btn primary">Comment</button><button class="btn cancel">Cancel</button>
    </div>`;
  block.after(box);
  const ta = box.querySelector("textarea");
  ta.focus();
  box.querySelector(".primary").onclick = async () => {
    await addComment(info.start, info.end, ta.value, info.quote);
  };
  box.querySelector(".cancel").onclick = () => box.remove();
}

// ---------- diff ----------
function diffLines(a, b) {
  const n = a.length,
    m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0,
    j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) ops.push({ t: "eq", a: i, b: j }), i++, j++;
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ t: "del", a: i }), i++;
    else ops.push({ t: "add", b: j }), j++;
  }
  while (i < n) ops.push({ t: "del", a: i }), i++;
  while (j < m) ops.push({ t: "add", b: j }), j++;
  return ops;
}

async function manifestFor(n) {
  if (state.manifestCache.has(n)) return state.manifestCache.get(n);
  const v = await api(`/api/projects/${enc(state.key)}/versions/${n}`).catch(() => null);
  const mf = v?.manifest || null;
  state.manifestCache.set(n, mf);
  return mf;
}

function versionSummary(n) {
  return state.versions.find((v) => v.n === n);
}

// Build the doc <select> for the diff (union of both sides' slugs). Hidden when
// both versions are flat (no docCount>1) so flat-vs-flat looks exactly as today.
async function updateDiffDocSel() {
  const from = versionSummary(state.baseVersion);
  const to = versionSummary(state.version);
  const treeDiff = (from?.docCount > 1) || (to?.docCount > 1);
  const wrap = $("diffDocWrap");
  wrap.hidden = !treeDiff;
  if (!treeDiff) return;

  const [mf, mt] = await Promise.all([manifestFor(state.baseVersion), manifestFor(state.version)]);
  const slugs = [];
  const seen = new Set();
  for (const mm of [mf, mt])
    for (const d of mm?.docs || [])
      if (!seen.has(d.slug)) {
        seen.add(d.slug);
        slugs.push({ slug: d.slug, title: d.title });
      }
  const prev = $("diffDocSel").value;
  $("diffDocSel").innerHTML = slugs.map((s) => `<option value="${esc(s.slug)}">${esc(s.title)}</option>`).join("");
  const wantRoot = state.manifest?.root || "root";
  if (slugs.some((s) => s.slug === prev)) $("diffDocSel").value = prev;
  else if (slugs.some((s) => s.slug === wantRoot)) $("diffDocSel").value = wantRoot;
  else if (slugs.length) $("diffDocSel").value = slugs[0].slug;
}

async function loadDiff() {
  if (!state.baseVersion) {
    $("diff").innerHTML = "<div class='empty'>No earlier version to compare against.</div>";
    $("diffStat").textContent = "";
    $("diffDocWrap").hidden = true;
    return;
  }
  state.baseVersion = Number($("baseSel").value);
  await updateDiffDocSel();
  const scoped = !$("diffDocWrap").hidden;
  const doc = scoped ? $("diffDocSel").value || "root" : null;
  const qs = `from=${state.baseVersion}&to=${state.version}${doc ? `&doc=${enc(doc)}` : ""}`;
  const d = await api(`/api/projects/${enc(state.key)}/diff?${qs}`);
  const a = (d.from.markdown || "").split("\n");
  const b = (d.to.markdown || "").split("\n");
  const ops = diffLines(a, b);
  const adds = ops.filter((o) => o.t === "add").length;
  const dels = ops.filter((o) => o.t === "del").length;
  $("diffStat").innerHTML = `<span class="add">+${adds}</span> <span class="del">−${dels}</span>`;
  $("diff").innerHTML = state.diffMode === "split" ? renderSplit(ops, a, b) : renderUnified(ops, a, b);
}

function renderUnified(ops, a, b) {
  const rows = ops
    .map((o) => {
      if (o.t === "eq")
        return `<tr><td class="ln">${o.a + 1}</td><td class="ln">${o.b + 1}</td><td class="sign"> </td><td class="code">${esc(a[o.a]) || "&nbsp;"}</td></tr>`;
      if (o.t === "del")
        return `<tr class="del"><td class="ln">${o.a + 1}</td><td class="ln"></td><td class="sign">−</td><td class="code">${esc(a[o.a]) || "&nbsp;"}</td></tr>`;
      return `<tr class="add"><td class="ln"></td><td class="ln">${o.b + 1}</td><td class="sign">+</td><td class="code">${esc(b[o.b]) || "&nbsp;"}</td></tr>`;
    })
    .join("");
  return `<table class="difftable">${rows}</table>`;
}

function renderSplit(ops, a, b) {
  const rows = [];
  let pendDel = [],
    pendAdd = [];
  const cell = (ln, text, cls) => `<td class="ln ${cls}">${ln}</td><td class="code ${cls}">${text}</td>`;
  const flush = () => {
    const k = Math.max(pendDel.length, pendAdd.length);
    for (let x = 0; x < k; x++) {
      const dl = pendDel[x],
        ad = pendAdd[x];
      const left = dl != null ? cell(dl + 1, esc(a[dl]) || "&nbsp;", "delc") : cell("", "", "emptyc");
      const right = ad != null ? cell(ad + 1, esc(b[ad]) || "&nbsp;", "addc") : cell("", "", "emptyc");
      rows.push(`<tr>${left}${right}</tr>`);
    }
    pendDel = [];
    pendAdd = [];
  };
  for (const o of ops) {
    if (o.t === "del") pendDel.push(o.a);
    else if (o.t === "add") pendAdd.push(o.b);
    else {
      flush();
      rows.push(`<tr>${cell(o.a + 1, esc(a[o.a]) || "&nbsp;", "")}${cell(o.b + 1, esc(b[o.b]) || "&nbsp;", "")}</tr>`);
    }
  }
  flush();
  return `<table class="difftable split">${rows.join("")}</table>`;
}

// ---------- review actions ----------
async function refreshReview() {
  const box = $("reviewActions");
  if (!state.reviewId) {
    box.hidden = true;
    return;
  }
  try {
    state.review = await api(`/api/reviews/${state.reviewId}`);
  } catch {
    box.hidden = true;
    return;
  }
  const pill = $("reviewPill");
  box.hidden = false;
  const onThisVersion = state.review.version === state.version;
  if (state.review.status === "pending") {
    pill.className = "pill pending";
    pill.textContent = onThisVersion ? "● review pending" : `● pending on v${state.review.version}`;
    $("approveBtn").hidden = !onThisVersion;
    $("rejectBtn").hidden = !onThisVersion;
  } else {
    pill.className = "pill " + state.review.status;
    pill.textContent = state.review.status === "approved" ? "✓ approved" : "↩ changes requested";
    $("approveBtn").hidden = true;
    $("rejectBtn").hidden = true;
  }
}

async function resolve(decision) {
  const review = await api(`/api/reviews/${state.reviewId}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision }),
  });
  await refreshReview();
  if (decision === "approve") {
    const n = review?.commentCount || 0;
    toast(
      n
        ? `Approved with ${n} comment${n === 1 ? "" : "s"} — Claude will proceed and incorporate them.`
        : "Plan approved — Claude will proceed.",
    );
  } else {
    toast("Sent back to Claude with your comments.");
  }
}

// ---------- storage / save ----------
function projectName() {
  return state.projects?.find((p) => p.key === state.key)?.name || "plan";
}
function projNameByKey(key) {
  return (
    state.manageProjects?.find((p) => p.key === key)?.name ||
    state.projects?.find((p) => p.key === key)?.name ||
    key
  );
}

function refreshSaveUI() {
  const box = $("saveActions");
  if (!state.version) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const g = state.storage?.gist;
  const btn = $("saveBtn");
  const link = $("savedLink");
  if (g?.id) {
    btn.textContent = state.version === g.savedVersion ? "Update gist" : `Save v${state.version} → gist`;
    link.hidden = false;
    link.href = g.htmlUrl;
    link.textContent = `gist · holds v${g.savedVersion}`;
  } else {
    btn.textContent = "Save to gist";
    link.hidden = true;
  }
}

function renderChannelStatus(ch) {
  const box = $("channelStatus");
  const confirm = $("saveConfirm");
  if (!ch) {
    box.className = "channelStatus warn";
    box.textContent = "Could not read channel status.";
    confirm.disabled = true;
    return;
  }
  if (ch.ready) {
    box.className = "channelStatus ok";
    box.textContent = "✓ GitHub CLI ready — gist scope present.";
    confirm.disabled = false;
  } else {
    box.className = "channelStatus warn";
    const cmd = ch.fixCommand ? ` Run:  ${ch.fixCommand}` : ch.fixUrl ? ` See ${ch.fixUrl}` : "";
    box.textContent = `⚠ ${ch.reason || "Channel not ready."}${cmd}`;
    confirm.disabled = true;
  }
}

async function openSaveModal() {
  const g = state.storage?.gist;
  $("saveTitle").textContent = g?.id ? "Update gist" : "Save plan to a gist";
  $("saveDesc").value = g?.description ?? `${projectName()} — plan`;
  $("saveFilename").value = g?.filename ?? "plan.md";
  $("saveHint").textContent = g?.id
    ? `Overwrites your secret gist (currently holds v${g.savedVersion}) with v${state.version}. GitHub keeps the gist's revision history.`
    : `Creates a secret (unlisted) gist with v${state.version}'s markdown. Only people with the link can see it.`;
  $("saveModal").hidden = false;

  const sel = $("saveChannel");
  $("channelStatus").textContent = "Checking GitHub CLI…";
  $("channelStatus").className = "channelStatus";
  $("saveConfirm").disabled = true;
  try {
    state.channels = await api("/api/channels");
  } catch {
    state.channels = [];
  }
  sel.innerHTML = state.channels.map((c) => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join("");
  const current = state.channels.find((c) => c.id === (sel.value || "gist")) || state.channels[0];
  if (current) sel.value = current.id;
  renderChannelStatus(current);
}

function closeSaveModal() {
  $("saveModal").hidden = true;
}

async function doSave() {
  const channel = $("saveChannel").value || "gist";
  const description = $("saveDesc").value.trim();
  const filename = $("saveFilename").value.trim() || "plan.md";
  const btn = $("saveConfirm");
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = "Saving…";
  try {
    const r = await api(
      `/api/projects/${enc(state.key)}/versions/${state.version}/save`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel, description, filename }),
      },
    );
    state.storage[channel] = r;
    closeSaveModal();
    refreshSaveUI();
    toast(`Saved v${state.version} to ${channel}.`);
  } catch (e) {
    renderChannelStatus({ ready: false, reason: e.message, fixCommand: e.fixCommand });
  } finally {
    btn.textContent = prev;
    btn.disabled = false;
  }
}

// ---------- deletion ----------
function showDeleteModal(title, desc) {
  $("deleteTitle").textContent = title;
  $("deleteDesc").textContent = desc;
  $("deletePending").hidden = true;
  $("deletePending").textContent = "";
  $("deleteForce").hidden = true;
  $("deleteConfirm").hidden = false;
  $("deleteConfirm").disabled = false;
  $("deleteForce").disabled = false;
  $("deleteModal").hidden = false;
}

function openDeleteVersion() {
  if (!state.version) return;
  state.pendingDelete = { type: "version", key: state.key, n: state.version };
  showDeleteModal(
    `Delete v${state.version}?`,
    `This permanently removes v${state.version} of “${projectName()}” and its comments. This can't be undone.`,
  );
}

function showDeleteBlocked(e) {
  const revs = e.pendingReviews || [];
  const info = $("deletePending");
  info.hidden = false;
  const many = revs.length !== 1;
  info.textContent =
    `Blocked: ${revs.length || "a"} pending review${many ? "s" : ""} still awaiting a decision. ` +
    `Force will auto-reject ${many ? "them" : "it"} (Claude is told the plan was deleted and to re-present or ask how to proceed), then delete.`;
  $("deleteForce").hidden = false;
  $("deleteConfirm").hidden = true;
}

// bulk-delete is always 200 with partial-success {deleted,blocked,meta}; render
// the blocked versions (+ their pending reviews) and offer a Force retry for
// just those. Single-version / project DELETE stay 409-on-block (showDeleteBlocked).
function showBulkBlocked(blocked, deleted) {
  const info = $("deletePending");
  info.hidden = false;
  const ns = blocked.map((b) => b.n);
  const totalPending = blocked.reduce((a, b) => a + (b.pendingReviews?.length || 0), 0);
  const many = totalPending !== 1;
  const delMsg = deleted.length ? `Deleted v${deleted.join(", v")}. ` : "";
  info.textContent =
    `${delMsg}Blocked: v${ns.join(", v")} — ${totalPending || "a"} pending review${many ? "s" : ""} ` +
    `still awaiting a decision. Force will auto-reject ${many ? "them" : "it"} (Claude is told the plan ` +
    `was deleted and to re-present or ask how to proceed) and delete the remaining ${ns.length} version${ns.length === 1 ? "" : "s"}.`;
  $("deleteForce").hidden = false;
  $("deleteForce").disabled = false;
  $("deleteConfirm").hidden = true;
}

async function finishDelete(pd, msg) {
  const wasManage = pd.fromManage;
  $("deleteModal").hidden = true;
  state.pendingDelete = null;
  toast(msg);
  await reloadAfterDelete();
  if (wasManage && !$("manageModal").hidden) await renderManage();
}

async function confirmDelete(force) {
  const pd = state.pendingDelete;
  if (!pd) return;
  const bconfirm = $("deleteConfirm");
  const bforce = $("deleteForce");
  bconfirm.disabled = true;
  bforce.disabled = true;
  const f = force ? "true" : "";
  try {
    if (pd.type === "bulk") {
      const r = await api(`/api/projects/${enc(pd.key)}/bulk-delete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ versions: pd.ns, force }),
      });
      const blocked = r?.blocked || [];
      const deleted = r?.deleted || [];
      if (blocked.length) {
        // partial success: some deleted, some blocked by pending reviews
        if (deleted.length) pd.didDelete = true; // reflect deletions even if user cancels
        pd.ns = blocked.map((b) => b.n); // Force retry targets only the blocked ones
        showBulkBlocked(blocked, deleted);
        return;
      }
      await finishDelete(pd, `Deleted ${deleted.length || pd.ns.length} version${(deleted.length || pd.ns.length) === 1 ? "" : "s"}.`);
      return;
    }

    if (pd.type === "version") {
      await api(`/api/projects/${enc(pd.key)}/versions/${pd.n}?force=${f}`, { method: "DELETE" });
      await finishDelete(pd, `Deleted v${pd.n}.`);
    } else if (pd.type === "project") {
      await api(`/api/projects/${enc(pd.key)}?force=${f}`, { method: "DELETE" });
      await finishDelete(pd, "Project deleted.");
    }
  } catch (e) {
    if (e.status === 409) showDeleteBlocked(e); // version / project block
    else {
      toast("Delete failed: " + e.message);
      bconfirm.disabled = false;
      bforce.disabled = false;
    }
  }
}

// Delete flows must explicitly reload projects/versions — the pollLoop only
// refreshes review status.
async function reloadAfterDelete() {
  await loadProjects();
  if (!state.projects.length) {
    showEmpty("No plans reviewed yet. Finish a plan in plan mode and it'll show up here.");
    return;
  }
  const key = state.projects.some((p) => p.key === state.key) ? state.key : state.projects[0].key;
  await selectProject(key);
}

// ---------- manage modal ----------
async function openManageModal() {
  $("manageModal").hidden = false;
  await renderManage();
}

async function renderManage() {
  const list = $("manageList");
  list.innerHTML = "<div class='empty'>Loading…</div>";
  const projects = await api("/api/projects").catch(() => []);
  const detailed = await Promise.all(
    projects.map(async (p) => {
      const r = await api(`/api/projects/${enc(p.key)}`).catch(() => ({ versions: [] }));
      return { ...p, versions: r.versions || [] };
    }),
  );
  state.manageProjects = detailed;
  list.innerHTML = detailed.length
    ? detailed.map(manageProjectHTML).join("")
    : "<div class='empty'>No projects.</div>";
}

function manageProjectHTML(p) {
  const vers = (p.versions || [])
    .map(
      (v) => `<label class="mg-ver">
        <input type="checkbox" data-key="${esc(p.key)}" data-n="${v.n}" />
        <span class="mg-vn">v${v.n}</span>
        <span class="mg-meta">${esc(new Date(v.createdAt).toLocaleString())}${v.docCount > 1 ? ` · ${v.docCount} docs` : ""}${v.kind === "tree" ? " · tree" : ""}</span>
      </label>`,
    )
    .join("");
  return `<div class="mg-project" data-key="${esc(p.key)}">
    <div class="mg-phead">
      <span class="mg-name">${esc(p.name)}${p.pending ? ` <span class="sb-dot" title="${p.pending} pending"></span>` : ""}</span>
      <span class="mg-actions">
        <button class="btn sm" data-mg="delsel" data-key="${esc(p.key)}">Delete selected</button>
        <button class="btn reject sm" data-mg="delproj" data-key="${esc(p.key)}">Delete project</button>
      </span>
    </div>
    <div class="mg-vers">${vers || "<span class='mg-meta'>no versions</span>"}</div>
  </div>`;
}

// ---------- polling (reflect external resolution) ----------
function pollLoop() {
  setInterval(async () => {
    if (state.reviewId && state.review && state.review.status === "pending") {
      try {
        const r = await api(`/api/reviews/${state.reviewId}`);
        if (r.status !== state.review.status) {
          state.review = r;
          refreshReview();
          renderSidebar(); // pending dot depends on review status
        }
      } catch {}
    }
  }, 2500);
}

// ---------- wiring ----------
function wireUI() {
  // theme toggle (light ⇄ dark); head script already applied any saved choice pre-paint
  const toggle = $("themeToggle");
  const isDark = () => {
    const t = document.documentElement.dataset.theme;
    if (t === "dark") return true;
    if (t === "light") return false;
    return matchMedia("(prefers-color-scheme: dark)").matches;
  };
  const paintToggle = () => (toggle.textContent = isDark() ? "☀️" : "🌙");
  paintToggle();
  toggle.onclick = () => {
    const next = isDark() ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("planReviewTheme", next);
    } catch {}
    paintToggle();
  };

  $("projectSel").onchange = (e) => selectProject(e.target.value);
  $("versionSel").onchange = (e) => loadVersion(Number(e.target.value));
  $("baseSel").onchange = () => loadDiff();
  $("diffDocSel").onchange = () => loadDiff();

  document.querySelectorAll(".tab").forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      state.tab = t.dataset.tab;
      $("panel-" + state.tab).classList.add("active");
      hideSelPop();
      if (state.tab === "diff") loadDiff();
    };
  });

  document.querySelectorAll(".seg").forEach((s) => {
    s.onclick = () => {
      document.querySelectorAll(".seg").forEach((x) => x.classList.remove("active"));
      s.classList.add("active");
      state.diffMode = s.dataset.mode;
      loadDiff();
    };
  });

  // view-as-tree (single-doc, display-only)
  $("treeToggle").onclick = () => {
    state.viewAsTree = !state.viewAsTree;
    state.treeSection = -1;
    updateTreeToggle();
    renderPreview();
    renderSidebar();
  };

  // sidebar navigation — doc rows (tree) or outline sections (view-as-tree)
  $("docSidebar").addEventListener("click", (e) => {
    const row = e.target.closest("[data-doc]");
    if (row) {
      e.preventDefault();
      if (row.dataset.doc !== state.doc) loadDoc(row.dataset.doc);
      return;
    }
    const sec = e.target.closest("[data-sec]");
    if (sec) {
      e.preventDefault();
      state.treeSection = Number(sec.dataset.sec);
      applyTreeView();
      renderSidebar();
    }
  });

  // comment on rendered text: after a selection in the preview, offer a "Comment" button
  document.addEventListener("mouseup", (e) => {
    if ($("selPop").contains(e.target)) return; // the button handles its own click
    const info = currentSelection();
    if (info) showSelPop(info);
    else hideSelPop();
  });
  window.addEventListener("scroll", hideSelPop, true);
  $("selComment").onclick = () => {
    const info = state.pendingSel;
    hideSelPop();
    window.getSelection().removeAllRanges();
    if (info) openComposer(info);
  };

  // preview clicks: cross-doc links navigate in-app; delete buttons remove comments
  $("preview").addEventListener("click", (e) => {
    const link = e.target.closest("a[data-doc]");
    if (link) {
      e.preventDefault();
      const slug = link.dataset.doc;
      if (state.docCache.has(slug) || (state.manifest && state.manifest.docs.some((d) => d.slug === slug))) {
        loadDoc(slug);
      }
      return;
    }
    const del = e.target.closest("[data-del]");
    if (del) delComment(del.dataset.del);
  });
  $("generalList").onclick = (e) => {
    const del = e.target.closest("[data-del]");
    if (del) delComment(del.dataset.del);
  };
  $("generalAdd").onclick = async () => {
    await addComment(null, null, $("generalInput").value);
    $("generalInput").value = "";
  };

  $("saveBtn").onclick = () => openSaveModal();
  $("saveCancel").onclick = () => closeSaveModal();
  $("saveConfirm").onclick = () => doSave();
  $("saveChannel").onchange = () =>
    renderChannelStatus(state.channels.find((c) => c.id === $("saveChannel").value));

  $("approveBtn").onclick = () => resolve("approve");
  $("rejectBtn").onclick = () => ($("rejectModal").hidden = false);
  $("rejectCancel").onclick = () => ($("rejectModal").hidden = true);
  $("rejectConfirm").onclick = async () => {
    const summary = $("rejectSummary").value.trim();
    if (summary) await addComment(null, null, summary);
    $("rejectSummary").value = "";
    $("rejectModal").hidden = true;
    await resolve("reject");
  };

  // deletion + manage
  $("deleteVerBtn").onclick = () => openDeleteVersion();
  $("deleteCancel").onclick = async () => {
    const pd = state.pendingDelete;
    $("deleteModal").hidden = true;
    state.pendingDelete = null;
    // a partial bulk delete already removed some versions — reflect that even on cancel
    if (pd && pd.didDelete) {
      await reloadAfterDelete();
      if (!$("manageModal").hidden) await renderManage();
    }
  };
  $("deleteConfirm").onclick = () => confirmDelete(false);
  $("deleteForce").onclick = () => confirmDelete(true);

  $("manageBtn").onclick = () => openManageModal();
  $("manageClose").onclick = () => ($("manageModal").hidden = true);
  $("manageList").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-mg]");
    if (!btn) return;
    const key = btn.dataset.key;
    if (btn.dataset.mg === "delproj") {
      state.pendingDelete = { type: "project", key, fromManage: true };
      showDeleteModal(
        `Delete project “${projNameByKey(key)}”?`,
        `Permanently removes the project and all its versions, comments and reviews. This can't be undone.`,
      );
    } else if (btn.dataset.mg === "delsel") {
      const ns = [...$("manageList").querySelectorAll('input[type="checkbox"]:checked')]
        .filter((x) => x.dataset.key === key)
        .map((x) => Number(x.dataset.n));
      if (!ns.length) {
        toast("Select at least one version to delete.");
        return;
      }
      state.pendingDelete = { type: "bulk", key, ns, fromManage: true };
      showDeleteModal(
        `Delete ${ns.length} version${ns.length === 1 ? "" : "s"} of “${projNameByKey(key)}”?`,
        `Permanently removes v${ns.join(", v")} and their comments. This can't be undone.`,
      );
    }
  });
}

init().catch((e) => {
  document.body.innerHTML = `<div class="empty">Failed to load: ${esc(e.message)}</div>`;
});
