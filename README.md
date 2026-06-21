# claude-plan-review

Review Claude Code **plans** in a local, GitHub-style web UI — leave persistent
comments, approve or send changes back to Claude, and keep every plan iteration
with its comments and diffs. All from the browser; no console needed.

When Claude finishes a plan in **plan mode**, a `PreToolUse` hook on the
`ExitPlanMode` tool intercepts it, opens the plan in your browser, and **blocks**
until you decide:

- **Approve** → Claude exits plan mode and starts implementing.
- **Request changes** → your line + general comments are sent back as the denial
  reason; Claude stays in plan mode and revises, producing a new version.

Everything is stored **outside your repo** (`~/.claude/plan-review/`), keyed by
the worktree path — so no `.gitignore` churn and no risk of committing review data.
Git worktrees are scoped separately automatically.

## Features

- 📄 GitHub-style **rendered preview** of the plan markdown
- 💬 **Line comments** + general comments, **persistent** across reloads
- 🕑 **Version history** — every `ExitPlanMode` is an immutable snapshot
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

### Option B — from a local clone (for hacking on it)

```bash
git clone https://github.com/pavlo-petrychenko/claude-plan-review
cd claude-plan-review
bun install                                  # or: npm install
bun  src/cli.js init /path/to/your/project   # …or…
node src/cli.js init /path/to/your/project   # writes an absolute-path hook command
```

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

## Usage

Use `bun` or `node` interchangeably (or `bunx`/`npx claude-plan-review …` when published):

| Command | What it does |
| --- | --- |
| `… cli.js init [dir] [--local] [--published] [--runtime bun\|node]` | Wire the `ExitPlanMode` hook into a project |
| `… cli.js serve [port]` | Start the review server manually (default `4607`) |
| `… cli.js stop` | Stop the running server |
| `… cli.js channels` | Show storage-channel readiness (is `gh` installed / authed / `gist`-scoped?) |

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
     approve  ──> hook emits {permissionDecision:"allow"}            ──> Claude implements
     request  ──> hook emits {permissionDecision:"deny", reason:...} ──> Claude revises (new version)
```

## Storage layout

```
~/.claude/plan-review/
  projects/<sanitized-cwd>/
    meta.json
    versions/0001.md  0001.json  0002.md  0002.json   # immutable snapshots
    comments/0001.json  0002.json                     # comments per version
  reviews/<id>.json                                    # pending/resolved review requests
```

## License

MIT
