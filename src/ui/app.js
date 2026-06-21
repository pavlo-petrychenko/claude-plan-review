"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.status === 204 ? null : res.json();
}

const state = {
  key: null,
  version: null,
  baseVersion: null,
  reviewId: null,
  review: null,
  versions: [],
  data: null, // { markdown, html, meta }
  comments: [],
  tab: "preview",
  diffMode: "split",
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

  wireUI();
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
  $("reviewActions").hidden = true;
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
  const { versions } = await api(`/api/projects/${encodeURIComponent(key)}`);
  state.versions = versions;
  if (!versions.length) {
    showEmpty("This project has no plan versions yet.");
    return;
  }
  const latest = versions.length ? versions[versions.length - 1].n : null;
  state.version = wantV || latest;

  const fmt = (v) => `v${v.n} · ${new Date(v.createdAt).toLocaleString()}${v.n === latest ? " (current)" : ""}`;
  $("versionSel").innerHTML = versions.map((v) => `<option value="${v.n}">${esc(fmt(v))}</option>`).join("");
  $("versionSel").value = String(state.version);

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
  state.data = await api(`/api/projects/${encodeURIComponent(state.key)}/versions/${n}`);
  state.comments = await api(`/api/projects/${encodeURIComponent(state.key)}/versions/${n}/comments`);
  $("diffCur").textContent = n;
  renderPreview();
  renderSource();
  renderGeneral();
  updateCommentCount();
  await refreshReview();
  if (state.tab === "diff") loadDiff();
}

// ---------- rendering ----------
function renderPreview() {
  $("preview").innerHTML = state.data.html || "<p class='empty'>(empty plan)</p>";
}

function commentsByLine() {
  const map = new Map();
  for (const c of state.comments) {
    if (c.line == null) continue;
    if (!map.has(c.line)) map.set(c.line, []);
    map.get(c.line).push(c);
  }
  return map;
}

function commentHTML(c) {
  return `<div class="comment" data-id="${c.id}">
    <div class="chead"><span><b>${esc(c.author)}</b> · ${new Date(c.createdAt).toLocaleString()}</span>
      <button class="del" data-del="${c.id}" data-line="${c.line ?? ""}">delete</button></div>
    <div class="cbody">${esc(c.body)}</div></div>`;
}

function renderSource() {
  const lines = (state.data.markdown || "").split("\n");
  const byLine = commentsByLine();
  const rows = lines
    .map((ln, i) => {
      const num = i + 1;
      const threads = byLine.get(num) || [];
      let html = `<div class="srow${threads.length ? " has-comments" : ""}" data-line="${num}">
        <div class="sgutter" data-add="${num}">${num}</div>
        <div class="scode">${esc(ln) || "&nbsp;"}</div></div>`;
      if (threads.length) {
        html += `<div class="threads">${threads.map(commentHTML).join("")}</div>`;
      }
      return html;
    })
    .join("");
  $("source").innerHTML = rows;
}

function renderGeneral() {
  const gen = state.comments.filter((c) => c.line == null);
  $("generalList").innerHTML = gen.length ? gen.map(commentHTML).join("") : "";
}

function updateCommentCount() {
  const n = state.comments.length;
  $("cCount").textContent = n ? n : "";
}

// ---------- comments ----------
async function addComment(line, body) {
  if (!body.trim()) return;
  await api(`/api/projects/${encodeURIComponent(state.key)}/versions/${state.version}/comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ line, body }),
  });
  state.comments = await api(`/api/projects/${encodeURIComponent(state.key)}/versions/${state.version}/comments`);
  renderSource();
  renderGeneral();
  updateCommentCount();
}

async function delComment(id) {
  await api(`/api/projects/${encodeURIComponent(state.key)}/versions/${state.version}/comments/${id}`, {
    method: "DELETE",
  });
  state.comments = state.comments.filter((c) => c.id !== id);
  renderSource();
  renderGeneral();
  updateCommentCount();
}

function openInlineComposer(line) {
  // remove any existing
  document.querySelector(".composer.inline")?.remove();
  const row = document.querySelector(`.srow[data-line="${line}"]`);
  if (!row) return;
  const box = document.createElement("div");
  box.className = "composer inline";
  box.innerHTML = `<textarea placeholder="Comment on line ${line}…"></textarea>
    <button class="btn primary">Comment</button><button class="btn cancel">Cancel</button>`;
  row.after(box);
  const ta = box.querySelector("textarea");
  ta.focus();
  box.querySelector(".primary").onclick = async () => {
    await addComment(line, ta.value);
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

async function loadDiff() {
  if (!state.baseVersion) {
    $("diff").innerHTML = "<div class='empty'>No earlier version to compare against.</div>";
    $("diffStat").textContent = "";
    return;
  }
  state.baseVersion = Number($("baseSel").value);
  const d = await api(
    `/api/projects/${encodeURIComponent(state.key)}/diff?from=${state.baseVersion}&to=${state.version}`,
  );
  const a = d.from.markdown.split("\n");
  const b = d.to.markdown.split("\n");
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
  await api(`/api/reviews/${state.reviewId}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision }),
  });
  await refreshReview();
  toast(decision === "approve" ? "Plan approved — Claude will proceed." : "Sent back to Claude with your comments.");
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
        }
      } catch {}
    }
  }, 2500);
}

// ---------- wiring ----------
function wireUI() {
  // theme picker (auto / light / dark), persisted; head script already applied it pre-paint
  const themeSel = $("themeSel");
  try {
    themeSel.value = localStorage.getItem("planReviewTheme") || "auto";
  } catch {
    themeSel.value = "auto";
  }
  themeSel.onchange = () => {
    document.documentElement.dataset.theme = themeSel.value;
    try {
      localStorage.setItem("planReviewTheme", themeSel.value);
    } catch {}
  };

  $("projectSel").onchange = (e) => selectProject(e.target.value);
  $("versionSel").onchange = (e) => {
    state.reviewId && (state.reviewId = state.reviewId); // keep
    loadVersion(Number(e.target.value));
  };
  $("baseSel").onchange = () => loadDiff();

  document.querySelectorAll(".tab").forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      state.tab = t.dataset.tab;
      $("panel-" + state.tab).classList.add("active");
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

  // source gutter clicks + comment deletes (delegated)
  $("source").onclick = (e) => {
    const add = e.target.closest("[data-add]");
    if (add) return openInlineComposer(Number(add.dataset.add));
    const del = e.target.closest("[data-del]");
    if (del) return delComment(del.dataset.del);
  };
  $("generalList").onclick = (e) => {
    const del = e.target.closest("[data-del]");
    if (del) delComment(del.dataset.del);
  };
  $("generalAdd").onclick = async () => {
    await addComment(null, $("generalInput").value);
    $("generalInput").value = "";
  };

  $("approveBtn").onclick = () => resolve("approve");
  $("rejectBtn").onclick = () => ($("rejectModal").hidden = false);
  $("rejectCancel").onclick = () => ($("rejectModal").hidden = true);
  $("rejectConfirm").onclick = async () => {
    const summary = $("rejectSummary").value.trim();
    if (summary) await addComment(null, summary);
    $("rejectSummary").value = "";
    $("rejectModal").hidden = true;
    await resolve("reject");
  };
}

init().catch((e) => {
  document.body.innerHTML = `<div class="empty">Failed to load: ${esc(e.message)}</div>`;
});
