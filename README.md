# claude-plan-review

Review Claude Code **plans** in a local, GitHub-style web UI — leave persistent
comments, approve or send changes back to Claude, and keep every plan iteration
with its comments and diffs. All from the browser; no console needed.

When Claude finishes a plan in **plan mode**, a `PreToolUse` hook on the
`ExitPlanMode` tool intercepts it, opens the plan in your browser, and **blocks**
until you decide:

- **Approve** → Claude exits plan mode and starts implementing **immediately** —
  no need to switch back to the terminal and confirm. (If you leave any comments
  before approving, they ride along as guidance for Claude to incorporate while
  implementing — "approve with comments".)
- **Request changes** → your line + general comments are sent back as the denial
  reason; Claude stays in plan mode and revises, producing a new version.

Everything is stored **outside your repo** (`~/.claude/plan-review/`), keyed by
the worktree path — so no `.gitignore` churn and no risk of committing review data.
Git worktrees are scoped separately automatically.

## Features

- 📄 GitHub-style **rendered preview** of the plan markdown
- 💬 **Line comments** + general comments, **persistent** across reloads
- 🌳 **Multi-document plans** — big plans as a navigable tree (root + linked subpages),
  with per-doc comments and diffs; plus a display-only "view as tree" toggle for flat plans
- 🕑 **Version history** — every `ExitPlanMode` is an immutable snapshot
- 🗑 **Delete** single versions, bulk-select, or a whole project (pending reviews are protected)
- 🔀 **Diff** current vs any previous version — **side-by-side or unified** (toggle)
- ✅ **Approve / request-changes** straight from the UI, fed back to Claude
- 🗂 Per-worktree scoping; per-project opt-in (only runs where you enable the hook)
- 📤 **Save a plan to a storage channel** — push the plan markdown to a secret
  **GitHub Gist** (one gist per project, overwritten on each save; GitHub keeps
  the gist's revision history). More channels can be added later.
- ⚡ Tiny, zero-framework UI; Bun server; one dependency (`marked`)

## Requirements

- **Either** [Bun](https://bun.sh) ≥ 1.1 **or** [Node](https://nodejs.org) ≥ 18 — the
  tool is plain ESM JavaScript and runs unchanged on both. `init` auto-detects which
  you have (preferring Bun) and writes the matching hook command; override with `--runtime`.
- Claude Code ≥ 2.1 (verified against 2.1.185)
- *(Optional, only for saving to a Gist)* the [GitHub CLI](https://cli.github.com)
  `gh`, logged in (`gh auth login`) with the `gist` scope. The tool reuses your
  existing `gh` session — it never asks for or stores a token of its own.

## Setup

Two ways to install, depending on whether it's been published to npm.

### Option A — published (recommended for end users)

No clone, no checkout. From inside the project you want to enable:

```bash
cd /path/to/your/project
bunx claude-plan-review init --published     # if you have Bun
npx  claude-plan-review init --published     # if you have Node
#   add --local to write .claude/settings.local.json instead (personal, gitignored)
```

`--published` makes the hook run via the package runner (`bunx`/`npx`), so it works on
any machine — nothing to keep in your repo but the one settings entry.


### All projects at once (global)

Install once, enable everywhere — the hook goes in your user-level `~/.claude/settings.json`:

```bash
npm install -g claude-plan-review     # or: bun add -g claude-plan-review
claude-plan-review init --global
```

This fires the review for plans in **every** project, with no per-project setup. Don't also
run a per-project `init` in the same project, or the hook will fire twice.

### Either way

**Reopen the `/hooks` menu once (or restart Claude Code)** in that project so the
new hook is picked up. Next time you finish a plan in plan mode, your browser opens
to the review. The server auto-starts on first use; nothing else to run.

## Team setup

Everything a colleague needs is scripted here — follow it verbatim. This section is
the single source of truth for how the team runs claude-plan-review.

**1. Install and wire everything up once, for all projects:**

```bash
npm install -g claude-plan-review        # or: bun add -g claude-plan-review
claude-plan-review init --global --published --runtime node   # pin --runtime to what your team uses
#   swap `--runtime node` for `--runtime bun` if the team standardises on Bun
```

That single `init --global --published` does five things:

- writes the `ExitPlanMode` **hook** to `~/.claude/settings.json` (fires in **every** project);
- writes the **Stop-hook gate** to the same settings — it keeps Claude polling a tools-first
  review instead of ending its turn while your decision is still pending (see below);
- installs the **`plan-review-multidoc` skill** to `~/.claude/skills/` (auto-triggers on large / sectioned plans);
- **registers the MCP server** (`plan_review_submit` / `plan_review_check` tools) via `claude mcp add --scope user`
  — if the `claude` CLI isn't found, it prints the exact command to run;
- prints the **CLAUDE.md guidance block**. Add `--write-claude-md` to append it to
  `~/.claude/CLAUDE.md` automatically (idempotent — fenced by `<!-- plan-review:start/end -->`).

`--published` makes the hook and MCP server run via `npx`/`bunx`, so there's nothing to
keep in any repo. **Pin `--runtime`** so everyone's hook command matches.

**2. Restart Claude Code** (or reopen `/hooks`) so the hook, skill, and MCP tools load.

**3. The review server is per-machine.** Each teammate reviews plans locally in their own
browser — it auto-starts on first use (`claude-plan-review serve` to start it by hand).
There is no shared server.

**4. Share finished plans via a storage channel.** To hand a reviewed plan to a colleague,
use **Save to gist** in the UI (one secret gist per project, see below). Run
`claude-plan-review channels` to verify `gh` is installed, logged in, and `gist`-scoped
before relying on it.

## Usage

Use `bun` or `node` interchangeably (or `bunx`/`npx claude-plan-review …` when published):

| Command | What it does |
| --- | --- |
| `… cli.js init [dir] [--local] [--published] [--runtime bun\|node] [--no-skill] [--write-claude-md]` | Wire the `ExitPlanMode` hook + the Stop-hook gate, install the skill, register the MCP server |
| `… cli.js serve [port]` | Start the review server manually (default `4607`) |
| `… cli.js stop` | Stop the running server |
| `… cli.js channels` | Show storage-channel readiness (is `gh` installed / authed / `gist`-scoped?) |
| `… cli.js skill` | (Re)install the `plan-review-multidoc` skill into `~/.claude/skills` |
| `… cli.js mcp` | (internal) run the stdio MCP server exposing the `plan_review_*` tools |
| `… cli.js stop-gate` | (internal) the `Stop` hook that blocks the turn from ending while a tools-first review is pending |

The server auto-starts on the first plan and stays up, so you can browse history
anytime at `http://localhost:4607`.

## Configuration (env vars)

| Var | Default | Meaning |
| --- | --- | --- |
| `PLAN_REVIEW_HOME` | `~/.claude/plan-review` | Where versions + comments are stored |
| `PLAN_REVIEW_PORT` | `4607` | Server port |
| `PLAN_REVIEW_TIMEOUT` | `1800` | Seconds the hook blocks waiting for your decision before falling back to Claude's normal approval prompt |

> The hook entry sets `timeout: 1800` so Claude Code waits while you review.

## Storage channels (save a plan out of the local store)

Each plan version lives only on your machine by default. A **storage channel**
lets you push the plan markdown somewhere shareable. Today there's one channel —
**GitHub Gist** — and the registry is built so more can be added later.

Click **Save to gist** in the header. The first save asks for a description and
file name and creates a **secret** (unlisted) gist from the version you're
viewing. There's **one gist per project**: saving any later version overwrites
that same gist (GitHub keeps the gist's own revision history), and you can rename
the description/file name on any save. The header then shows a link to the gist
and which version it currently holds.

Auth is delegated entirely to the GitHub CLI — if you've run `gh auth login`,
nothing else is needed and **no token is ever stored by this tool**. If `gh`
isn't installed, isn't logged in, or its token lacks the `gist` scope, the save
dialog tells you the exact command to fix it (e.g. `gh auth refresh -s gist`).
Run `claude-plan-review channels` to check readiness from the terminal.

> Note: the Gist API requires a **classic** `gh` token scope (`gist`);
> fine-grained tokens don't support gists. `gh auth login` handles this for you.

## How it works

```
Claude finishes plan ──> PreToolUse hook (ExitPlanMode)
                          │  reads {plan, planFilePath, cwd, session_id} from stdin
                          │  stores a new version under ~/.claude/plan-review/<cwd-key>/
                          │  ensures the server is up, opens the browser
                          │  BLOCKS, polling for your decision
   browser (you) ─────────┘
     approve  ──> hook emits {permissionDecision:"allow", updatedInput, additionalContext?} ──> Claude implements
                  (updatedInput is what skips the native "Exit plan mode?" prompt;
                   additionalContext carries any comments as "approve with comments")
     request  ──> hook emits {permissionDecision:"deny", reason:...}                        ──> Claude revises (new version)
```

## Multi-document plans

A big plan reads better as a **tree of documents** — a root overview plus linked
subpages (and sub-subpages) — than as one long scroll. The review UI renders that
tree with a sidebar you can navigate; comments and diffs are scoped per document.

Claude authors a tree by putting **document-separator markers** in the plan — one
HTML comment per document, alone on its own line (invisible when rendered as plain
markdown):

```
<!--doc slug=root title="Overview"-->
Top-level summary, linking to [[api]] and [[data-model]].

<!--doc slug=api title="API Design" parent=root-->
API section… details in [[api-auth]].

<!--doc slug=api-auth title="Auth" parent=api-->
Auth details.
```

- `slug` — required, kebab-case (`^[a-z0-9][a-z0-9-]*$`), unique.
- `title` — required (double-quote if it contains spaces).
- `parent` — optional; omit (or `root`/empty) for a top-level doc. **Exactly one root.**
- Content before the first marker becomes the root doc automatically.
- **Zero markers ⇒ a single-doc plan**, stored flat exactly as before (no migration).
- Cross-doc links: `[[slug]]`, `[[slug|text]]`, or `[text](doc:slug)` — every target
  must be a defined slug. Marker lines inside fenced code blocks are ignored.

A **"view as tree"** toggle in the UI also splits a plain single-doc plan into a
navigable tree by its headings — display-only, nothing changes on disk.

### Two ways a plan gets created

1. **Plan mode** (the usual path). Claude finishes a plan in plan mode; the
   `ExitPlanMode` hook validates the tree and opens the review. Malformed structure
   (missing root, duplicate slug, dangling link…) is bounced back to Claude with the
   exact problems to fix.
2. **Tools-first** (outside plan mode). Claude calls the **`plan_review_submit`** MCP
   tool to open a review, then **`plan_review_check`** to poll for your decision. Both
   are registered by `init` (see [Team setup](#team-setup)). Under the hood this uses
   the same store as the hook, so reviews look identical either way. (A `POST /api/plans`
   HTTP endpoint is the fallback when the MCP server isn't registered.)

   `plan_review_check` accepts a **`wait`** parameter (seconds, default `0`, capped at `120`):
   the call long-polls — it blocks server-side until you decide or `wait` elapses, then
   returns — so Claude gets your decision promptly instead of sleeping between checks.
   The recommended value is `20`, which keeps each call short while a loop re-issues it.

   Because the plan-mode hook blocks synchronously but the tools-first path does not, a
   **Stop-hook gate** (also installed by `init`) provides the enforcement: if Claude tries
   to end its turn while a tools-first review it submitted is still pending (created within
   the last 5 hours), the gate blocks and tells Claude to resume calling `plan_review_check`
   until the review resolves. It fails open on any error and never gates plan-mode reviews.

The `plan-review-multidoc` **skill** (installed by `init`) teaches Claude to reach for
the doc-tree format automatically whenever a plan is large or splits into sections.

## Deleting plans

Plans no longer accumulate forever. From the UI you can:

- **Delete a single version** — a per-version button with an in-app confirm.
- **Bulk-delete / delete a whole project** — the manage modal (trash icon in the
  header): tick versions and delete them, or remove the project entirely.

Deleting the **last** version removes the project directory outright. A version with a
**pending review** is protected: the delete returns `409` and the UI offers **Force**,
which auto-rejects that review (telling Claude the plan was deleted) before removing it.

## Storage layout

```
~/.claude/plan-review/
  projects/<sanitized-cwd>/
    meta.json
    versions/
      0001.json                       # version meta (both kinds; carries `kind`, `docCount`)
      0001/                            # tree version → a directory
        manifest.json                 # {root, docs:[{slug,title,parent,file,order}]}
        root.md  api.md  api-auth.md  # one file per document
      0002.md  0002.json              # flat single-doc plan (legacy or markerless)
    comments/0001.json  0002.json     # comments per version (each comment carries its `doc`)
  reviews/<id>.json                   # pending/resolved review requests
```

Single-doc plans keep the exact flat `NNNN.md` layout from earlier versions — their
content hash is unchanged, so dedup and history keep working with no migration.

## License

MIT
