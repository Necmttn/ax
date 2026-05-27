# Grounded Agent Files - Design

**Status:** draft
**Date:** 2026-05-27
**Author:** brainstorm w/ Necmttn, feedback from janniks (hackagu)

## Motivation

User feedback (paraphrased):

> I want `ax` to recommend changes to my agent files. Run `ax`, get 5 recs,
> pick 3, optionally reword, manually add. Or auto-maintain a file where I
> know exactly which lines came from ax. Less surprises, low friction.
> Session-end hook is fine for auto stuff, but transparency matters. Also
> want a manual run mode that scans all sessions, filter by project / cwd /
> agent.

Mapped to existing ax surface, ~70% of the plumbing already exists. Today
`derive-retro-proposals.ts` emits `form="guidance"` proposals targeting
`CLAUDE.md` / `AGENTS.md`, but `acceptProposal()` only handles `form="skill"`
(direct file scaffold). The guidance/subagent/hook/automation forms return
`unsupported_form` and the user has no way to see, apply, or track them.

This spec defines:

1. A **provenance marker convention** so individual lines/blocks in a user's
   `AGENTS.md` / `CLAUDE.md` (and other agent-config artifacts) can be
   traced back to a specific ax experiment.
2. A **task-handoff envelope** (`.ax/tasks/<id>.md`) that decouples ax
   (recommender) from the user's agent (applier). ax never writes user
   files directly; it produces a self-contained brief that any agent
   (Claude Code, Codex, etc.) can execute.
3. A **`ax recommend`** command (manual run, filterable).
4. A **`ax lint`** command that parses provenance markers, reconciles them
   with the DB, and reports drift.
5. A **generalized accept** path that emits tasks for all proposal forms,
   phased by risk.

## Goals

- Transparency: every ax-originated line is identifiable; every applied
  experiment links back to evidence the user can inspect.
- Safety: ax does not write user files in the default flow. The user's
  agent does - under the user's direct supervision, in the user's editor.
- Symmetric lifecycle: same DB shape (proposal → experiment → checkpoint →
  verdict) drives recommend, apply, and lint across all forms.
- Token-efficient markers: HTML comments, invisible in rendered markdown
  and effectively zero context cost for downstream LLMs that re-read the
  agent files.
- Composable: works whether user pipes through `ax recommend` once, runs
  it on a schedule, or wires it into a hook.

## Non-Goals

- Auto-applying changes to user files. Even the session-end hook variant
  only produces task files; it never edits `AGENTS.md` directly.
- Replacing the deterministic `scaffoldSkill()` writer; it remains
  available behind an opt-in flag for headless use.
- Hook (`settings.json`) and automation (LaunchAgent) auto-apply land in
  later phases. v0 covers guidance + skill only.

## Architecture

```
┌─────────────────┐  proposal       ┌──────────────────┐
│  derive-*       │ ──────────────▶ │  proposal table  │
│  (existing)     │                 │  + form payload  │
└─────────────────┘                 └────────┬─────────┘
                                             │
                            ┌────────────────┴────────────────┐
                            │                                 │
                  user runs ▼                                 │
                  ┌──────────────────┐                        │
                  │  ax recommend    │  print + clipboard     │
                  │  --project --cwd │  (or --apply / --patch)│
                  │  --agent --limit │                        │
                  └────────┬─────────┘                        │
                           │ user picks                       │
                           ▼                                  │
                  ┌──────────────────┐                        │
                  │  ax accept <id>  │ ───────────────────────┤
                  └────────┬─────────┘                        │
                           │ emits                            │
                           ▼                                  │
                  ┌──────────────────┐                        │
                  │ .ax/tasks/<id>.md│                        │
                  │ (form-aware)     │                        │
                  └────────┬─────────┘                        │
                           │ user's agent reads + applies     │
                           ▼                                  │
                  ┌──────────────────┐                        │
                  │ target file w/   │                        │
                  │ provenance marker│                        │
                  └────────┬─────────┘                        │
                           │ user runs                        │
                           ▼                                  │
                  ┌──────────────────┐  reconcile             │
                  │  ax lint         │ ───────────────────────▶ DB
                  │  (scan + verify) │  (UPDATE experiment)
                  └──────────────────┘
```

Existing tables (`proposal`, `guidance_proposal`, `skill_proposal`,
`subagent_proposal`, `hook_proposal`, `automation_proposal`, `experiment`,
`checkpoint`, `guidance`, `guidance_revision`) are unchanged in shape. New
fields are additive only.

## Provenance Marker Convention

### Form: guidance (inline in markdown files)

Paired HTML comments, free-roaming inside the target file. Marker pairs
are not constrained to any region or section; experiments can attach to
bullets, paragraphs, code fences, or inline phrases.

Token shape (single id, ~12 chars overhead for an inline use):

```
<!--ax:e7f3-->wrapped content of any length<!--/ax:e7f3-->
```

Multiline:

```md
## Terminal

<!--ax:e7f3-->
- Use ripgrep instead of grep.
- Use fd instead of find.
<!--/ax:e7f3-->
```

Inline inside user prose:

```md
When debugging async code, <!--ax:9a21-->always log the event loop tick
before the await<!--/ax:9a21-->.
```

Parser rule: for every `<!--ax:ID-->`, find nearest subsequent
`<!--/ax:ID-->` with matching id (no nesting of the same id; different ids
may interleave). Body is the span between.

### Form: skill / subagent (whole-file artifacts)

YAML frontmatter:

```yaml
---
name: ripgrep-over-grep
description: Use ripgrep instead of grep when searching code.
ax_id: e7f3
ax_experiment: experiment:guid_e7f3__lk9
---
```

Existing `scaffoldSkill()` already writes frontmatter; this spec adds the
two `ax_*` keys.

### Form: hook (JSON edits to `~/.claude/settings.json`)

JSON cannot carry comments. Use a sibling `_ax` map at the top level:

```json
{
  "hooks": {
    "PreToolUse:Bash": [ ... ]
  },
  "_ax": {
    "hooks.PreToolUse:Bash[0]": "e7f3"
  }
}
```

Key is a JSON-pointer-ish path to the hook entry; value is the ax id.
`ax lint` walks `_ax` and verifies each pointer still resolves and the
referenced entry still matches the experiment's expected shape.

### Form: automation (LaunchAgent plist or cron entry)

Plist comment header (XML supports comments natively):

```xml
<!-- ax:e7f3 experiment:guid_e7f3__lk9 -->
<?xml version="1.0" ...>
```

cron: leading line `# ax:e7f3 experiment:guid_e7f3__lk9`.

## Task Handoff Envelope

`ax accept <sig-or-id>` (and `ax recommend --apply`) emits a task file at
`.ax/tasks/<id>.md` relative to the cwd of the invocation (repo-local by
default; on first write, ax also appends `.ax/` to the repo's
`.gitignore` if it can detect one, unless the user opts in to tracking).
Overridable with `--task-dir` or `AX_TASK_DIR=...`.

Template (form-aware):

```md
# ax task: e7f3 (form=guidance)

**Action:** insert guidance block
**Target:** ~/.claude/CLAUDE.md → `## Terminal Optimization`
**Marker:** `<!--ax:e7f3-->...<!--/ax:e7f3-->`

## Why
Detected from 12 corrections across 4 sessions.
Proposal: proposal:guid_e7f3
Experiment: experiment:guid_e7f3__lk9
Confidence: high. Frequency: 3/wk.

## Apply
1. Open `~/.claude/CLAUDE.md`. Locate `## Terminal Optimization`. If the
   section does not exist, create it just above `## Output Token Limits`.
2. Insert the marker block. The body is suggested wording - you may
   reword it, but keep the `<!--ax:e7f3-->` and `<!--/ax:e7f3-->` tags
   untouched.
3. Run `ax lint ~/.claude/CLAUDE.md`. Resolve any warnings.
4. Commit. The task file is removed automatically by `ax lint` once it
   sees the marker land in the target.

## Suggested body

> Use ripgrep instead of grep when searching code. Faster, better
> defaults, and respects `.gitignore`.

## References
- proposal: proposal:guid_e7f3
- experiment: experiment:guid_e7f3__lk9
- evidence-cmd: `ax show e7f3`
- baseline: 12 corrections across 4 sessions, 2026-05-15..2026-05-26
```

Form-specific `Apply` sections differ:

- **skill:** "Create `~/.claude/skills/<slug>/SKILL.md` with the
  frontmatter and body below."
- **subagent:** "Create `~/.claude/agents/<slug>.md` with the
  frontmatter and prompt below."
- **hook:** "Add the hook entry below to `~/.claude/settings.json`
  under `hooks.PreToolUse:Bash`, and add the matching `_ax` pointer at
  the top level."
- **automation:** "Create LaunchAgent plist at the path below. Header
  comment must contain `ax:e7f3`."

Lifecycle:

- Created on `ax accept`.
- Removed on `ax lint` once the provenance marker is detected at the
  target.
- Stale (no marker after N days, default 7) → `ax lint` warns. User can
  `ax accept --redo <id>` or `ax reject <id>` to clear.

## Commands

### `ax recommend [opts]`

Manual run. Reads proposals from DB, ranks them, prints N as
ready-to-paste blocks (already wrapped in provenance markers for the
forms where that makes sense), and copies to clipboard.

Flags:

- `--limit N` (default 5)
- `--project <name>` (filter by `project` table)
- `--cwd <path>` (filter by observed cwds on related sessions)
- `--agent <claude|codex>` (filter by harness)
- `--form <guidance|skill|subagent|hook|automation>` (filter by form;
  multi: `--form guidance,skill`)
- `--since <duration>` (e.g. `7d`; uses proposal `updated_at`)
- `--apply` - interactive picker; on confirm, calls `ax accept` per
  chosen rec, which emits the task files.
- `--patch` - write a single `.ax/pending.patch` with a sketch of the
  changes (markers + suggested insertion points) for `git apply` use.
- `--json` - machine-readable output.

Default behaviour (no flags) mirrors Jannik's "print + clipboard" mental
model. `--apply` opens the picker for the auto-maintain crowd.

### `ax accept <sig-or-id> [opts]`

Universal accept. For every form, emits `.ax/tasks/<id>.md`. Idempotent:
second `ax accept` on the same id reprints the task file path.

Flags:

- `--auto-scaffold` - for `form=skill` only, retains today's deterministic
  `scaffoldSkill()` path (writes the SKILL.md directly, skips task file).
  Backwards-compat for headless workflows.
- `--task-dir <path>` - override task output dir.
- `--force` - overwrite an existing task file.

### `ax reject <sig-or-id> --reason <text>`

Unchanged from today; closes the proposal.

### `ax lint [files...]`

Scans the listed files for provenance markers, or auto-discovers:

- `./AGENTS.md`, `./CLAUDE.md` (cwd, walking up to git root)
- `~/.claude/CLAUDE.md`, `~/.claude/AGENTS.md`
- `~/.claude/skills/*/SKILL.md`, `~/.claude/agents/*.md`
- `~/.claude/settings.json` (`_ax` map)
- `~/Library/LaunchAgents/com.necmttn.ax-*.plist`

Rules:

| Rule | Severity | Action |
|---|---|---|
| Unmatched open/close tag | error | report file:line |
| Duplicate id in same file | error | report both occurrences |
| Orphan id (no DB row) | warn | suggest `ax forget <id>` |
| Regressed verdict in DB | info | suggest review or removal |
| Pending task w/ marker present | (none - side effect) | delete `.ax/tasks/<id>.md`, `UPDATE experiment SET scaffolded_at = time::now(), artifact_path = <observed>` |
| Stale task (no marker after 7d) | warn | suggest `ax reject --reason stale` |
| ID collision across files | warn | report all locations |

Output: human format by default, `--json` for tooling.

Exit codes: 0 = clean, 1 = warnings, 2 = errors.

### `ax show <id>`

Pretty-print everything ax knows about one experiment: proposal evidence,
related sessions, checkpoints, verdict history, current marker locations.
Drives both the CLI and the dashboard "rendered UI" Jannik described.

## Accept-Path Refactor

Today (skill-only):

```ts
acceptProposal -> form='skill' -> scaffoldSkill(writes file)
                -> else -> 'unsupported_form'
```

Proposed:

```ts
acceptProposal -> any form ->
  1. UPSERT experiment(proposal, artifact_path=null, scaffolded_at=null)
  2. emit .ax/tasks/<id>.md (form-aware template)
  3. proposal.status = 'accepted'
  4. experiment.status = 'task_emitted' (new column, see below)
```

`scaffoldSkill()` becomes `acceptProposal({ ..., autoScaffold: true })`,
preserved as opt-in.

Schema additions (additive only):

```sql
DEFINE FIELD status ON experiment TYPE string DEFAULT 'task_emitted';
  -- task_emitted | scaffolded | regressed | retired
DEFINE FIELD task_path ON experiment TYPE option<string>;
  -- absolute path to .ax/tasks/<id>.md while pending
```

`ax lint` transitions `task_emitted → scaffolded` on marker detection.
Verdict transitions (`scaffolded → regressed/retired`) flow from the
existing `setVerdict()` and checkpoint pipeline.

## Data Flow

1. Ingest pipeline (existing) ingests transcripts, derives proposals.
2. User runs `ax recommend --project ax --limit 5`. CLI queries
   `proposal WHERE status = 'open'`, joins form payload, ranks by
   confidence × recency × frequency. Prints + clipboard.
3. User runs `ax accept e7f3`. Mutation in `src/improve/actions.ts`:
   - fetch proposal, validate status,
   - UPSERT experiment,
   - render task template (new module `src/improve/task-template.ts`),
   - write `.ax/tasks/<id>.md`,
   - UPDATE proposal.status, experiment.status, experiment.task_path.
4. User points their primary agent at the task file: `claude, do
   .ax/tasks/e7f3.md`. Agent reads, applies, commits.
5. User runs `ax lint`. Scanner (new module `src/improve/lint.ts`)
   discovers files, parses markers, reconciles with DB, deletes
   completed task files, reports drift.
6. Future: `derive-checkpoints.ts` (existing) measures whether the
   recommendation reduced the corrective signal it was derived from. If
   ratio collapses to 0 after sustained marker presence, checkpoint
   suggests `regressed`. `ax retro` (existing) walks user through
   locking verdicts.

## Error Handling

- **Marker parse errors:** `ax lint` reports `error` severity with
  file:line. Non-zero exit. No DB mutation.
- **DB unreachable:** all commands fall back to a read-only fast path
  where possible (`ax recommend` can refuse; `ax lint` can still report
  marker-shape errors). Mutations require DB.
- **Task file already exists on `ax accept`:** abort with
  `scaffold_exists`-style status; surface existing experiment_id and
  task_path so user can decide. `--force` overwrites.
- **Conflicting markers across files (same id, different content):**
  `ax lint` warns; ax does not auto-resolve. Resolution is a user task.
- **User edits inside marker but keeps tags:** allowed and expected.
  `ax lint` does not diff body against the original `suggested_text`;
  it only verifies marker presence and id↔DB linkage.

## Testing

Following the project's bun:test conventions:

- **Marker parser** (`src/improve/markers.test.ts`):
  pairing, nested-different-ids, missing-close, duplicate-id, frontmatter
  detection, JSON `_ax` pointer resolution, plist comment scan.
- **Task template** (`src/improve/task-template.test.ts`):
  snapshot per form, frontmatter rendering, body escaping.
- **Accept refactor** (`src/improve/agent-accept.test.ts`):
  extend to cover guidance/subagent/hook/automation task emission;
  retain skill auto-scaffold path with explicit flag.
- **Lint** (`src/improve/lint.test.ts`):
  fixtures under `tests/fixtures/agent-files/` covering clean, orphan,
  regressed, duplicate, stale-task, and JSON-hook cases. Verify
  experiment status transitions in DB.
- **`ax recommend` CLI** (`src/cli/recommend.test.ts`):
  filter combinations, ranking, clipboard mock, `--json` parity.
- **End-to-end** (`src/improve/grounded-files.e2e.test.ts`):
  derive proposal → accept → emit task → simulate user-agent applying
  marker → lint detects → DB updates → checkpoint measures.

## Phasing

| Phase | Forms | Surface |
|---|---|---|
| **v0** | guidance, skill | marker convention, `.ax/tasks/<id>.md` envelope, `ax recommend`, `ax accept` task path, `ax lint` core, `ax show`, dashboard `/improve` read-only view of markers |
| **v1** | + subagent | extend task template, lint scan for `~/.claude/agents/`, dashboard subagent row |
| **v2** | + hook | JSON `_ax` map, `settings.json` scan, dogfooded against ax's own hooks |
| **v3** | + automation | plist/cron header scan, explicit manual-only flag (no auto-apply ever) |

Each phase ships independently; v0 unlocks Jannik's core ask.

## Open Questions

- Should `ax recommend` default to "global view" (all projects, all cwds)
  or "scope to cwd"? Jannik asked for filters, so global default + filter
  flags. But "I'm in a repo" → scope-by-cwd may be more intuitive.
  Suggest: scope-by-cwd by default, `--all` to widen.
- ID format: keep current short hash (`e7f3` style, derived from
  `dedupe_sig`) or expose full proposal key? Short is friendlier in
  markers; risk = collisions across long timescales. Suggest short, with
  collision check in `ax lint` (`ID collision across files` rule) and a
  one-time prefix-extension migration if it ever bites.
- Should marker bodies be diff-tracked against the DB's `suggested_text`?
  Could power "ax noticed you reworded, want to save your version?"
  prompts. Out of scope for v0; revisit after adoption signal lands.

## Risks

- **Marker rot.** User reorganizes file, ax can't find marker, lint
  flags as orphan, user gets confused. Mitigation: lint message points
  to last-known location + grep recipe.
- **Task spam.** User accepts 10 recs, gets 10 task files, never applies
  any. Mitigation: `--limit` on recommend, stale-task warnings, optional
  `--patch` mode that collapses to one diff.
- **JSON hook edits.** `_ax` map at top of `settings.json` is unusual.
  Mitigation: hook form deferred to v2; document the convention as part
  of ax's settings.json contract before shipping.
- **Two ax installs (global + worktree).** Markers in `~/.claude/CLAUDE.md`
  could be written by one install, lint'd by another. Mitigation:
  marker id is DB-derived, so as long as both installs share the
  SurrealDB instance at `127.0.0.1:8521` (current default), they
  reconcile cleanly. Worth a doc note.
