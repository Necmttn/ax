---
name: ax-extract-workflow
description: Reconstruct the workflow behind a past artifact - "what made X work" / "extract workflow from <date|sha>" / "how did we ship Y". Uses ax to find the relevant sessions and narrate the ordered skill arcs that produced the result. Triggers on "what made X work", "how did we build Y", "extract workflow from <date>", "extract workflow from <sha>", "what was the workflow around <topic>", "show me how I shipped <feature>", "reconstruct the recipe for <artifact>". Do NOT fire on generic "show recent activity" - this skill is for reconstructing the workflow behind a specific artifact.
role: framing
---

# ax:extract-workflow - reconstruct the recipe behind a shipped artifact

Given a deliverable (a demo, a PR, a feature) the user wants to know:
what skills, in what order, produced it? This skill resolves an anchor
(date or sha), windows the relevant sessions, and narrates the ordered
skill arcs in plain text. Eats its own dogfood: it is itself a framing
skill.

Assumes `ax` (axctl) is on PATH and the local SurrealDB is running.
If `ax sessions here` fails with a connection error, tell the user
`scripts/db-start.sh` and stop.

## When to fire

ONLY on explicit reconstruction triggers:
- "what made <X> work" / "how did we ship <Y>"
- "extract workflow from <date>" / "extract workflow from <sha>"
- "what was the workflow around <topic>"
- "reconstruct the recipe for <artifact>"
- "show me how I built <feature>"

Do NOT fire on generic "what did I do today" or "show recent activity".
That is `ax sessions here` territory, not this skill.

## Step 1 - resolve the anchor

Decide one of three modes based on what the user gave you:

| User said | Mode | Action |
|---|---|---|
| commit sha (full or short) | sha | use it directly |
| date or date range (YYYY-MM-DD) | date | use `ax sessions around <date>` |
| topic / feature / artifact name | topic | `ax recall "<topic>" --sources=commit --json` to find candidate shas |
| "this repo, recently" | pwd | `ax sessions here --days=14` |

For topic mode pick the most relevant sha and proceed in sha mode. If
results are ambiguous, ask the user to pick one before continuing.

## Step 2 - window the sessions

Pick the right command for the resolved anchor:

- sha mode:    `ax sessions near <sha> --json`
- date mode:   `ax sessions around <date> --days=3 --json`
- pwd mode:    `ax sessions here --days=14 --json`

Pick the N most relevant sessions from the JSON (default N=5). Bias to
sessions with the highest turn counts and that touch files related to
the artifact.

## Step 3 - inspect each session

For each picked session:

    ax sessions show <id> --json
    ax sessions show <id> --by-role     # optional, see Step 4

Read the `top_skills` and `agent_delegations` arrays. If a subagent's
work looks central to the artifact, drill in:

    ax sessions show <id> --expand=<subagent-uuid>

## Step 4 - narrate

Produce two artifacts inline (no files written - keep the answer in chat).

### 4a. Ordered skill arc

Lead with the framing skill that opened the work (use `--by-role` output
if available - the `framing` group goes first). Then execution skills,
then verification. For each skill, name it and write one line on what
it produced.

Example:

    1. brainstorming    -> defined the workflow extraction problem
    2. writing-plans    -> turned 13 grilled questions into a plan
    3. subagent-driven  -> executed the plan as 17 typed-CLI tasks
    4. code-review      -> two-stage spec + quality review per task
    5. test-driven-dev  -> 100% green throughout

### 4b. Key decisions

Pull 2-4 turn excerpts where the user steered the work. Use:

    ax recall "<keyword>" --skill=<framing-skill> --limit=5 --json

Quote one line per decision; cite the session id.

### 4c. Reproducer brief (optional, if user asks)

A one-paragraph "to do this again, you would" summary - the skills, the
order, and the key user inputs at the steering points.

## When to recommend ax skills classify

If `ax sessions show <id> --by-role` returns many skills in the
`(unclassified)` group, the role-weighted output above will be noisy.
Suggest the user run `ax skills classify` once - it generates briefs
the user can fill in to seed roles. Don't block on it; the
artifact-reconstruction story still works without roles.

## Output contract

Write everything inline. Do not create files under `.ax/tasks/` or
anywhere else. Do not modify the repo. This is a read-only,
reconstruction-focused skill.

If the user asks for a permanent recipe, recommend they paste your
output into `docs/recipes/<name>.md` themselves - ax intentionally has
no recipe save format yet (per the workflow-extraction-frictions plan).
