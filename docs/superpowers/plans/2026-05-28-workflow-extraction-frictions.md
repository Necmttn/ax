# Workflow Extraction + Friction Fixes - Implementation Plan

> Dogfood evidence: session `3d6a3531-9eb7-4212-9d12-9cde70ae5d72` (2026-05-28, 47min, 90 Bash calls) - agent investigated "which skills made the hackable-platform workbench demo" using ax. Frictions surfaced below.

**Goal:** Drop "what made X work" investigation from 30+ bash calls → ≤5. Agent (Claude/Codex) drives reasoning; ax surfaces fast-path data via typed CLI helpers + a thin orchestration skill. **No recipe artifact in v0** - agent narrates output inline.

**Non-goals (v0):** Recipe save/replay format. `ax session diff`. Static role-taxonomy seed file. Cross-repo workflow library.

**Grilled decisions:** Locked via 13-question grill session, captured below in each phase.

---

## Frictions observed (with session evidence)

| # | Friction | Evidence from `3d6a3531` |
|---|---|---|
| F1 | Default ingest missed codex+subagent → 4 sessions found; after codex ingest → 205 | Phase 4 of session, user nudged "ingest back to date" |
| F2 | No raw-SQL or typed CLI for windowed queries - agent reinvented SurrealQL via bash for every cut | 30+ `bun ax ... <<SQL` bash hops |
| F3 | No `--around <sha>` / commit-anchored windowing | Bash: "Find workbench/demo/video commits" → "Sessions around demo date" |
| F4 | `recall` BM25 covers turns only - NOT commit messages | Agent did `git log --grep` separately to find demo commit |
| F5 | Skill weighting is invocation-count flat - `dogfood` (1 invocation) produced the entire demo | dogfood=1, batch-read-upfront=5; flat view inverts importance |
| F6 | No "from-pwd" targeted ingest - agent hand-resolved `~/.claude/projects/<slug>/` | Agent did "Find hackable project" + "All hackable project dirs" |
| F7 | Subagent sessions: **1424/1667 (85%) missing `repository` link** despite cwd being present | Confirmed via DB spike during grill |

---

## CLI surface (locked)

```
# Ingest
ax ingest here [--since=Nd]      # F6 - pwd→repo→session-set, includes git stage targeted
ax sessions/near auto-detect staleness, run delta-ingest if cheap (Q6.D)

# Queries
ax sessions here [--days=N]      # repo-aware (Q4.C): traverse repository→checkout→session
ax sessions near <sha>           # adaptive window (Q8.C): sha~1..sha commit range; fallback ±3d
ax sessions around <date> [--days=N --project=PATH]
ax session show <id>             # collapsed subagents + auto markdown/JSON (Q9.ii+c)
                                 #   --expand=<uuid> | --all  (drill into subagents)
                                 #   --json  (force machine output)
                                 #   --by-role  (group by role node)

# FTS
ax recall <q> [--sources=turn,commit,skill] [--scope=here|all]  # Q7.C: default scope=here
ax commits search <q>            # alias

# Skills + roles (graph reads, Q3 edges)
ax skills weighted [--window=...]  # GROUP via plays_role->role; doctor-mode (Q11.B)
ax skills by-role <role>
ax skills roles <skill>            # list role edges with confidence + source
ax roles                           # list role nodes
ax skills classify [<skill>...]    # emit briefs for unclassified skills (Q10/Q11)
ax skills tag <skill> <role>       # manual override; writes plays_role edge source="user"
```

JSON output via `--json` everywhere; auto when piped (`!isatty`).

---

## Schema deltas

### F4 - Commit FTS

```sql
DEFINE ANALYZER IF NOT EXISTS commit_text TOKENIZERS class FILTERS lowercase, snowball(english);
DEFINE INDEX commit_message_fts ON commit FIELDS message SEARCH ANALYZER commit_text BM25 HIGHLIGHTS;
```

### F5 - Skill roles as RELATE edge (Q3)

```sql
DEFINE TABLE role SCHEMAFULL;
DEFINE FIELD name   ON role TYPE string;   -- "framing" | "execution-mode" | "execution" | "producer" | "verification" | "repair"
DEFINE FIELD weight ON role TYPE float;    -- default scoring weight (tuned post-classification)
DEFINE INDEX role_name_uq ON role FIELDS name UNIQUE;

DEFINE TABLE plays_role TYPE RELATION FROM skill TO role;
DEFINE FIELD confidence ON plays_role TYPE float DEFAULT 1.0;
DEFINE FIELD source     ON plays_role TYPE string;        -- "frontmatter" | "brief" | "user"
DEFINE FIELD weight     ON plays_role TYPE option<float>; -- per-edge override of role.weight
DEFINE FIELD rationale  ON plays_role TYPE option<string>;
DEFINE FIELD since      ON plays_role TYPE datetime DEFAULT time::now();
DEFINE INDEX plays_role_in  ON plays_role FIELDS in;
DEFINE INDEX plays_role_out ON plays_role FIELDS out;
```

Multi-role natural: one skill → many `plays_role` edges. Weighted query joins `invoked → skill → plays_role → role`.

### F5 - Position-aware invocation signals

```sql
DEFINE FIELD turn_index   ON invoked TYPE option<int>;   -- position within session
DEFINE FIELD total_turns  ON invoked TYPE option<int>;
DEFINE FIELD is_first     ON invoked TYPE option<bool>;  -- first invocation of this skill in session
```

Backfilled at ingest from session turn order.

---

## Phases

### Phase 1 - Foundation (unblocks dogfood) ✱

- [ ] **F7 fix - backfill subagent repository.** One-shot migration + ingest-time inheritance from parent session. Closes the 85% gap. (Q5.B)
- [ ] **`src/lib/pwd.ts`** - resolve `$PWD` → git repo root → `repository` node (via `remote_url` or `initial_commit`).
- [ ] **`ax ingest here [--since=Nd]`** - scope all stages (skills/transcripts/codex/git) to the resolved repository's session set. Reuses existing `--stages=` plumbing.
- [ ] **Auto-delta ingest on stale.** `ax sessions here/near` checks transcript-dir mtimes vs `session.raw_file` set. Delta ≤ N files → silent backfill; > N → warn + offer flag. (Q6.D)
- [ ] **Commit FTS index + backfill** over existing 134 commits.
- [ ] **`ax recall --sources=turn,commit,skill --scope=here|all`** - extend `fetchRecall`; default `--scope=here` when in a git repo. (Q7.C)
- [ ] Tests: bun:test against fixture sessions + commit table.

### Phase 2 - Typed session queries

- [ ] **`ax sessions here|around|near` commands** (Effect CLI module).
  - `near <sha>`: resolve `git rev-list <sha>~1..<sha>` → window between predecessor commit ts and this commit ts. Fallback ±3d if commit is orphaned. (Q8.C)
  - `here`: anchor = `repository` of `$PWD`. Window via `--days=N` or all.
- [ ] **`ax session show <id>`** - orders `invoked` + `tool_call` by ts; collapses subagent sessions to single-line summary by default; `--expand=<uuid>` / `--all` drill-in. Auto markdown (TTY) vs JSON (piped). (Q9.ii+c)
- [ ] All commands `--json` flag for skill consumption.

### Phase 3 - Role weighting (graph + briefs)

- [ ] Schema deltas (above) - `role`, `plays_role`, position fields on `invoked`.
- [ ] **Frontmatter ingest** for ax-owned skills (`skill/ax-*/SKILL.md`): read `role:` field, write `plays_role` edge with `source="frontmatter"`. (Q10.B)
- [ ] **`ax skills classify`** - emit one brief per unclassified skill with ≥3 invocations to `.ax/tasks/classify-<skill>.md`. Brief content:
  - skill name, description, plugin source
  - useful CLI commands the agent should run before deciding:
    - `ax skills stats <skill>`
    - `ax skills recent <skill> --limit=10`
    - `ax recall ... --skill=<skill> --limit=5 --json`
    - `ax session show <id>` (one or two recent example sessions)
  - fields to fill: `primary_role`, `secondary[]`, `confidence`, `rationale`
- [ ] **`ax skills tag <skill> <role>`** - writes/updates `plays_role` edge with `source="user"`.
- [ ] **Lint pipeline** - `ax improve lint` (or new `ax skills lint`) reads filled briefs → writes `plays_role` edges with `source="brief"`. Mirrors `ax improve accept` pattern.
- [ ] **`ax skills weighted [--window=...]`** - graph-traversal query. **Doctor pattern (Q11.B):** if N+ unclassified skills with ≥3 invocations exist, emit guidance message + brief paths + show raw counts; agent self-iterates.
- [ ] **Read commands** (Q3 follow-up):
  - `ax skills by-role <role>`
  - `ax skills roles <skill>`
  - `ax roles`
  - `ax session show <id> --by-role`

### Phase 4 - `ax-extract-workflow` skill (Q13.A)

- [ ] **`skill/ax-extract-workflow/SKILL.md`** - orchestration skill, ~1 page:
  - Trigger phrases ("what made X work", "extract workflow from <date|sha>", "how did we ship Y")
  - Step pseudocode:
    1. Resolve anchor: if user gave sha → use it; if date or topic → `ax commits search <q>` to find candidate shas; if "current pwd" → `ax sessions here`
    2. `ax sessions near <sha> --json`
    3. Agent picks N most-relevant sessions
    4. `ax session show <id> --json` for each (collapsed view by default)
    5. Narrate: ordered skill arcs (framing first via role lookup), key decisions (pull user-turn excerpts via FTS), reproducer brief
  - Frontmatter: `role: framing` (eats own dog food)
- [ ] **`ax setup` installs the skill** to `~/.claude/skills/ax-extract-workflow/` (and `~/.agents/skills/...` for codex).

---

## Out of scope (this plan)

- `ax replay <recipe>` and recipe save format (revisit after extraction is in real use)
- Cross-project workflow library / sharing
- LLM auto-classification of skill roles (revisit if brief workflow becomes a maintenance burden)
- Codex's 34% missing-repo gap (orthogonal: codex sessions sometimes start outside any tracked repo)
- `ax session diff <a> <b>` (no dogfood evidence of need; signals like `ax skills recovery` cover the "why A worked, B failed" case better)

---

## Grilled decisions (reference)

| # | Question | Pick |
|---|---|---|
| Q1 | Success criterion: friction fixes vs recipe artifact | A - friction fixes; recipe deferred |
| Q2 | Skill weighting: taxonomy vs raw signals | Taxonomy (but agent-classified) |
| Q3 | Role: enum field vs RELATE edge | RELATE edge (multi-role natural) |
| Q4 | PWD ingest match rule | C - repo-aware via `repository` traversal |
| Q5 | Subagent repo gap | B - fix backfill, not fallback path |
| Q6 | Auto-ingest on `sessions here/near` | D - delta-on-stale, threshold-gated |
| Q7 | Commit FTS scope default | C - scope=here default, `--scope=all` opt-in |
| Q8 | `near <sha>` window | C - adaptive via git commit graph |
| Q9 | `session show` shape | (ii) collapsed subagents + (c) auto markdown/JSON |
| Q10 | Role seed source | Drop static seed; frontmatter for ax-owned + agent brief for rest |
| Q11 | Classification trigger | B - doctor-mode guidance on weighted query |
| Q12 | `ax session diff` | Drop from v0 |
| Q13 | Phase 4 deliverable | A - ship `skill/ax-extract-workflow/SKILL.md` |
