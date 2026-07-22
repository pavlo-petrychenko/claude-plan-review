---
name: plan-review-multidoc
description: Author an implementation plan as a navigable tree of documents (root overview + linked subpages) instead of one long markdown blob, and get it reviewed in the claude-plan-review browser UI. Use whenever a plan is large, spans several sections/areas, is multi-part, would benefit from being split into sections, or when the user asks for a nested/structured/multi-document plan.
when_to_use: A plan is large or complex, splits naturally into multiple sections or areas, is multi-part, or the user asks for a nested / structured / multi-document plan (or to "split it into sections"). Covers both plan mode and getting a plan reviewed outside plan mode.
allowed-tools: Bash, Read
---

# Multi-document plans for claude-plan-review

When a plan is large or naturally sectioned, author it as a **tree of documents** —
a root overview plus linked subpages (and sub-subpages) — so the reviewer can
navigate it in the browser UI instead of scrolling one long blob. A small, simple
plan needs none of this: write it as plain markdown and it stays a single document.

## Marker syntax

One HTML comment per document, **alone on its own line** (harmless if rendered as
plain markdown). Attributes are order-independent.

```
<!--doc slug=root title="Overview"-->
Top-level summary. Links to the subpages: [[api]], [[data-model]].

<!--doc slug=api title="API Design" parent=root-->
API section… see [[api-auth]] for details.

<!--doc slug=api-auth title="Auth" parent=api-->
Auth details.
```

Rules:
- `slug` — required, kebab-case `^[a-z0-9][a-z0-9-]*$`, unique.
- `title` — required (wrap in double quotes if it contains spaces).
- `parent` — optional; **omit it for the single top-level doc** (conventionally slugged
  `root`). Child docs set `parent` to their parent's slug (e.g. `parent=root`).
- **Exactly one root** (the doc with no parent). Every `parent` must be a defined slug.
- Content before the first marker becomes the root doc automatically.
- **Zero markers ⇒ a single-doc plan** — stored flat, exactly as a normal plan.
- Cross-doc links: `[[slug]]`, `[[slug|link text]]`, or `[text](doc:slug)`. Every
  target must be a defined slug.
- Marker lines inside fenced code blocks (```` ``` ````/`~~~`) are ignored — you can
  show marker examples in code fences safely.

> An `EnterPlanMode` PreToolUse hook (installed by `init`) injects a short reminder of
> this marker format as you start planning — it only adds context and never affects
> your consent to enter plan mode. This skill is the full reference behind that nudge.

## Path A — in plan mode (preferred when you're already planning)

Put the **whole tree in the single ExitPlanMode plan string**, using the markers
above. The plan-review hook splits it into documents, validates the structure, and
opens the review. If the structure is malformed (missing root, duplicate slug,
dangling link, …) the hook denies with the exact list of problems — fix them and
re-present with ExitPlanMode.

## Path B — outside plan mode (tools-first)

Use the **`plan_review_submit`** MCP tool to open a review, then **`plan_review_check`**
to poll for the decision. This is the primary path when you are not in plan mode.

1. Call `plan_review_submit` with `cwd` (the project's absolute path) and **exactly one** of:
   - `docs` — an array of `{slug, title, parent?, body}` (the structured tree), or
   - `plan` — a raw string with the `<!--doc ...-->` markers above, or
   - `markdown` — a single markdown document (no tree).
   It returns `{ reviewId, reviewUrl, projectKey, version }` and opens the browser.
   If the plan is structurally invalid it returns an error listing every problem — fix and resubmit.
2. Call `plan_review_check` with `{reviewId, wait: 20}` and keep calling it in a **loop** while the
   status is `pending`. The tool long-polls (blocks up to `wait` seconds server-side), so each call
   returns as soon as the user decides. **Do not end your turn while the review is pending** — call
   again immediately. Give up only after ~5 hours total, then ask the user.
   - `approved` → implement; incorporate `notes` if present ("approve with comments").
   - `rejected` → revise per `reason` and resubmit with `plan_review_submit`.
   - `pending` → call `plan_review_check` again now with `wait: 20`.

### Fallback — no MCP server registered

If the `plan_review_submit` / `plan_review_check` tools are not available (the
`plan-review` MCP server isn't registered), fall back to the HTTP API:

1. Resolve the port from `~/.claude/plan-review/server.json` (`.port`), else `4607`.
2. `POST /api/plans` with `{cwd, docs:[…]}` OR `{cwd, markdown}` OR `{cwd, plan}`:
   ```bash
   curl -s -X POST http://localhost:4607/api/plans \
     -H 'content-type: application/json' \
     -d '{"cwd":"/abs/project","docs":[{"slug":"root","title":"Overview","body":"…"}]}'
   ```
   `201` → `{key, version, reviewId, reviewUrl}`. `400` → `{error, issues}` (fix and re-POST).
   On connection failure, tell the user to run `claude-plan-review serve`.
3. Poll `GET /api/reviews/:reviewId` every ~3s; read `status` (`pending`/`approved`/`rejected`),
   `notes`, `reason`. Give up after ~5 hours and ask the user.
