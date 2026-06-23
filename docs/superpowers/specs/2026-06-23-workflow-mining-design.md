# Workflow Mining - codify recurring skill arcs (#588)

**Issue:** #588 (Milestone B of the directive-mining v2 goal package)
**Status:** Designed 2026-06-23 (brainstormed from directive-mining-design.md §2.7).
**Depends on:** Milestone A (#587, merged) - reuses its proposal/brief/dojo/`section`-discriminator machinery.
**Gate:** Execution-ready, but B is gated on A's bet proving out (do mined *directive* proposals get accepted?). Building it now is an explicit override; the loop's value isn't confirmed until directive/workflow proposals are acted on.

---

## 1. Problem

A (#587) mines **atomic** standing-instructions (single-turn directives). B is the **sequence** rung of the same ladder: recurring *ordered arcs of skill invocations* - e.g. `brainstorming → writing-plans → subagent-driven-development → review → commit` - that a user repeats across sessions. When an arc recurs, it's a candidate to **codify as a reusable skill** so the user doesn't re-improvise it each time.

ax already has the two halves this builds between:
- **Raw sequence extraction exists:** `WORKFLOW_SESSION_SEQUENCES_SQL` (`apps/axctl/src/queries/workflow.ts`) yields per-session ordered skill invocations (`is_first=true`, subagent-excluded).
- **Reactive narration exists:** the `ax-extract-workflow` skill explains the arc *behind a given artifact* ("how did we ship X").

The gap B fills: **proactive recurring-arc mining** - find arcs that repeat across many sessions and propose codifying them. Nothing today turns "you did this 7 times" into "here's a skill for it."

## 2. Approach - rides A's pipeline, one new detector

The whole loop reuses Milestone A's machinery; the only genuinely new code is the pure `mineArcs` detector + a thin proposal-derivation + one CLI subcommand.

```
WORKFLOW_SESSION_SEQUENCES_SQL  (exists)
   →  mineArcs            recurring ordered skill subsequences (pure, new)
   →  workflow proposal   form=skill, section="workflows", frequency=support (reuses deriveProposals)
   →  ax directives workflows --emit-brief  →  .ax/tasks/workflows-<date>.md
   →  agent confirms + names the workflow
   →  ax improve accept --auto-scaffold     →  ~/.claude/skills/<name>/SKILL.md (stub, agent-enriched)
   →  recurrence / verdict for free         (reuses A's frequency + verdict)
```

**Locked decisions (from brainstorm):**
- **Payload = a scaffolded SKILL.md.** Accepting a workflow proposal scaffolds a stub skill via the existing `improve --auto-scaffold` path; the agent fills real content via the existing `--with-agent` brief. Never auto-writes a final skill (avoids "noisy arc → noisy skill").
  > **Implementation note (as built):** proposals are minted as **`form="guidance"` + `section="workflows"`** (NOT `form="skill"` - the `skill` proposal form is coupled to a `skill_candidate` record that arcs don't have). `acceptProposal` recognizes `section="workflows"` via the pure `shouldScaffoldWorkflowSkill` predicate and routes `--auto-scaffold` to the SKILL.md path; directives (`section="directives"`) and other guidance stay on the brief/inline path. Wherever this doc or the plan says `form="skill"`, read `form="guidance"` + `section="workflows"`.
- **Step unit = skills only.** An arc is an ordered sequence of skill invocations from the existing `WORKFLOW_SESSION_SEQUENCES_SQL`. Zero new extraction. Tool-classes/episodes deferred (noisier).
- **Discriminator = `section="workflows"`** on the guidance/skill proposal payload - mirrors A's `section="directives"` so `list`/dojo/MCP filtering is free.
- **No new table.** Workflow proposals live in the existing `proposal`/`*_proposal` tables. Recurrence = `frequency`.

## 3. Detection - `mineArcs` (the one new algorithm)

Pure, DB-free, TDD'd.

**Input:** `ReadonlyMap<sessionId, readonly string[]>` - per-session ordered skill-name lists (built from `WORKFLOW_SESSION_SEQUENCES_SQL` rows by a thin `buildPerSession` reshaper).

**Output:** `ArcCandidate[]` = `{ steps: readonly string[]; support: number }` where `support` = count of **distinct sessions** containing the arc.

**Algorithm:**
- Mine frequent **gapped ordered subsequences**: steps must appear in the same relative order within a session, but may have other skills between them (tolerate noise).
- Bounds: arc length **3–6** skills; **support ≥ 3** distinct sessions.
- **Maximality (noise control):** drop an arc that is a strict subsequence of another mined arc with **equal or higher support** - keep the maximal recurring arc, not its fragments.
- **Firehose cap:** an arc's support counts a session at most once; cap total candidates (e.g. top 50 by support) so one prolific session can't dominate.
- Canonicalize by the skill-name tuple → `dedupe_sig = skill__<hash("workflow:" + tuple.join(">"))>` (stable across runs).

**Why gapped, not contiguous:** real workflows interleave with one-off skills (a `recall` here, a `commit` there); requiring contiguity would miss the recurring spine. Order is the signal, adjacency is not.

## 4. Codification - reuse `improve --auto-scaffold`

- `deriveWorkflowProposalRows(arcs, opts)` builds proposal rows: `form=skill`, `section="workflows"`, `title` = a readable arc summary (`"Workflow: brainstorm→plan→build→review→commit"`), `frequency` = support, stable `dedupe_sig`, evidence = the arc + example session ids.
- Folded into the existing `deriveProposals` (a new derive step beside the directive one); `workflowProposals` added to `ProposalsStats`. Only emits when arcs exist.
- Accept path is the **existing** `acceptProposal({ autoScaffold: true })` - scaffolds `~/.claude/skills/<slug>/SKILL.md` with `ax_id`/`ax_experiment` frontmatter + the arc + recurrence evidence as the stub body. `--with-agent` enriches. `ax improve lint` reconciles. No new accept logic.

## 5. Surface

- **CLI:** `ax directives workflows [--emit-brief] [--days=N] [--json]` - one new subcommand under the existing `ax directives` root. With `--emit-brief`, writes `.ax/tasks/workflows-<date>.md` (mirrors A's `mine --emit-brief`); else prints ranked arcs. A pure `renderWorkflowsBrief(arcs, {date, days})` renderer (TDD'd) with a per-arc fill block: `is_workflow? · skill_name · landing(skill) · rationale`.
- **Agent-facing:** workflow proposals surface in `ax improve recommend`/`list` and the dojo agenda for free (they're `section="workflows"` proposals). v1 adds NO new MCP tool - the existing `improve_*` tools cover it. (Optional follow-up: a `workflows` filter on `directives_list`.)
- **Docs gates:** `ax directives workflows` documented in `docs/cli.md`, `llms.txt`, `-cli-reference.data.ts`, root `CLAUDE.md` (the `directives` command already exists, so this is an additive subcommand row).

## 6. Scope + testing

- **v1 = mine → propose → scaffold.** Measuring "did codifying the workflow reduce re-improvisation" is deferred; recurrence-drop is the free proxy (the arc stops re-surfacing once the skill exists).
- **TDD targets (pure):** `mineArcs` (recurring arc detected at support≥3; sub-tuple suppressed by a higher-support superset; sub-threshold/short arcs dropped; gapped match across noise), `buildPerSession` (orders by ts/turn_index), `deriveWorkflowProposalRows` (arc→row mapping, stable sig, form=skill/section=workflows), `renderWorkflowsBrief` (one row per arc + fill block, empty-list safe).
- **Live dogfood at the gate:** mine real arcs from the local graph; cross-check a top arc against `ax-extract-workflow` on a known shipped artifact; confirm `--emit-brief` writes a sane brief and `improve accept --auto-scaffold` produces a stub skill. **Run any DB-backed query live** (Milestone A's lesson: a `FROM x AS y` style parse error is invisible to DB-free unit tests).

## 7. Explicitly NOT (v1)

- No new table, no new ingest table, no tool-class/episode step extraction, no new MCP tool, no "did it help" measurement beyond recurrence, no auto-written final skills (stub + agent only), no contiguous-sequence matching.

## 8. Reuse map

| Concept | Reused from | File |
|---|---|---|
| per-session ordered skill arcs | `WORKFLOW_SESSION_SEQUENCES_SQL` | `queries/workflow.ts` |
| mine→propose→accept→verdict | the proposal pipeline | `ingest/derive-proposals.ts` + `improve/` |
| `section`-discriminator for list/dojo | A's `section="directives"` pattern | `improve/list.ts` (`listDirectiveProposals`) |
| scaffold a skill from a proposal | `acceptProposal({autoScaffold})` | `improve/actions.ts` |
| brief renderer + `--emit-brief` | A's `mine` / routing-tune | `cli/commands/ax-directives.ts`, `ax-routing.ts` |
| dojo agenda item | A's `directives` item pattern | `dojo/items.ts`, `agenda.ts` |

## 9. Implementation slices

1. `queries/workflow-sequences.ts` - `buildPerSession` (pure) + `fetchWorkflowArcs` (wraps `WORKFLOW_SESSION_SEQUENCES_SQL` → `mineArcs`).
2. `mineArcs` (pure, in the same file) - recurring gapped-subsequence detector with maximality + caps.
3. `deriveWorkflowProposalRows` in `ingest/derive-proposals.ts` + `workflowProposals` in `ProposalsStats`; fold into `deriveProposals`.
4. `ax directives workflows` subcommand + `renderWorkflowsBrief` (in `cli/commands/ax-directives.ts` / a `workflows-brief-template.ts`).
5. Docs gates (cli.md, llms.txt, -cli-reference.data.ts, CLAUDE.md).
6. Gate: full verify + live dogfood + final review + PR.
