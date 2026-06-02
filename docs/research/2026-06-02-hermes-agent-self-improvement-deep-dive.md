# hermes-agent self-improvement deep dive

**Studied:** `NousResearch/hermes-agent` @ `272c2f30aa60d6d98b2c97dde6ba42a9231d4f56` (2026-06-01), cloned to `/tmp/hermes-agent-study`.
**Author of this note:** research pass for ax (2026-06-02). Read the source, not just the README.

---

## What hermes-agent is

Hermes is Nous Research's open-source personal AI agent - a single-user, locally-run agent harness (think "your own Claude Code / Codex, self-hosted") with a CLI, a desktop app, a TUI gateway, and platform gateways (Telegram/Discord/etc.). It is a large Python monorepo: the core agent loop lives in `run_agent.py` (the `AIAgent` class, ~4700 lines) split across `agent/*.py` helpers; tools live in `tools/*.py`; pluggable capabilities (memory backends, browser, kanban, model providers) live in `plugins/*`; agent-usable knowledge lives in `skills/*` (filesystem `SKILL.md` packages, same shape as Claude Code skills). State is local: `~/.hermes/` (`HERMES_HOME`) holds `memories/`, `skills/`, session SQLite DBs, cron jobs, config. **Stack:** Python ≥3.x, OpenAI-style function-calling against many providers, SQLite for session state, plain markdown + JSON sidecars for memory/skills, optional external memory services via plugins (Honcho, Mem0, Hindsight, etc.). No central server, no telemetry pipeline.

---

## Architecture map

| Concern | File(s) |
|---|---|
| Main agent loop / `AIAgent` | `run_agent.py` |
| Per-turn conversation orchestration (compression, hooks, **review triggers**) | `agent/conversation_loop.py` |
| Agent init, config wiring, **nudge-interval defaults** | `agent/agent_init.py` |
| **Background self-improvement review** (the core loop) | `agent/background_review.py` |
| **Skill curator** (background consolidation/lifecycle) | `agent/curator.py`, `agent/curator_backup.py` |
| Built-in memory store (MEMORY.md + USER.md) | `tools/memory_tool.py` |
| Skill CRUD tool the agent self-authors with | `tools/skill_manager_tool.py`, `tools/skills_tool.py` |
| Skill usage telemetry + lifecycle states | `tools/skill_usage.py` |
| Skill provenance (agent-created vs bundled vs hub) | `tools/skill_provenance.py` |
| External memory provider ABC | `agent/memory_provider.py`; manager: `agent/memory_manager.py` |
| Honcho provider (user-modeling backend) | `plugins/memory/honcho/{__init__,client,session,cli}.py` |
| Skills Hub (install + manual publish) | `tools/skills_hub.py`, `hermes_cli/skills_hub.py` |
| Cron / scheduled jobs | `cron/{jobs,scheduler}.py` |

**Data stores (all under `~/.hermes/`, all local):**
- `memories/MEMORY.md` - agent's own notes (env facts, project conventions, tool quirks).
- `memories/USER.md` - what the agent knows about the *user* (preferences, comm style, workflow habits).
- `skills/<category>/<name>/SKILL.md` (+ `references/`, `templates/`, `scripts/`) - agent-authored or installed skills.
- `skills/.usage.json` - per-skill usage counters + derived `last_used` timestamp + lifecycle `state`.
- `skills/.curator_state` - curator scheduler state (`last_run_at`, `paused`).
- Session SQLite DBs - transcripts, titles.

---

## Self-improvement subsystem (the deep dive)

### The mechanism in one sentence
After roughly every N turns, Hermes **forks a copy of itself** that re-reads the just-finished conversation and is prompted "should any memory or skill be saved/updated?" - and that fork writes directly to the local `MEMORY.md` / `USER.md` files and the local `SKILL.md` library. That's the whole loop.

### 1. Memory / user-modeling

Two parallel implementations.

**Built-in (always-on option):** plain markdown files, *not* a DB, no FTS/vector. `tools/memory_tool.py`:
```python
#  - MEMORY.md: agent's personal notes and observations (environment facts, project
#    conventions, tool quirks, things learned)
#  - USER.md: what the agent knows about the user (preferences, communication style,
#    expectations, workflow habits)
# Both are injected into the system prompt as a frozen snapshot at session start.
# Mid-session writes update files on disk immediately (durable) but do NOT change
# the system prompt -- this preserves the prefix cache for the entire session.
```
A single `memory` tool with `action ∈ {add, replace, remove, read}`; entries are `§`-delimited multiline text; `replace`/`remove` match by short unique substring. **Char limits**, not token limits (`memory_char_limit: 2200`, `user_char_limit: 1375`) "because char counts are model-independent." Recall = the whole file pasted into the system prompt at session start (frozen snapshot → prefix-cache-stable). So built-in "memory" is a bounded, curated, human-readable scratchpad - closer to a `SOUL.md`/persona file than a retrieval store.

**External (optional, one at a time):** a `MemoryProvider` ABC (`agent/memory_provider.py`) with a rich lifecycle: `initialize / prefetch(query) / sync_turn / on_session_end / on_pre_compress / on_delegation / on_memory_write`. `MemoryManager` enforces "one external provider at a time to prevent tool-schema bloat." Honcho is the flagship (`plugins/memory/honcho/`). Honcho is an *AI-native* memory service - it does not store rows you query; it stores **peer representations** and answers via **dialectic Q&A**:
```
# Provides cross-session user modeling with dialectic Q&A, semantic search,
# peer cards, and conclusions.
```
`HonchoSession` (session.py) tracks `user_peer_id` / `assistant_peer_id` / `honcho_session_id` and async-writes turns to Honcho; recall (`prefetch`) layers a cached **base context** (`peer.context()` → representation + card) plus an LLM **dialectic supplement** (`peer.chat()`), throttled by `dialectic_cadence` / `context_cadence` so it doesn't run every turn. So "long-term memory of user preferences" is delegated to Honcho's server-side user model; Hermes just feeds it turns and asks it questions. Other backends (Mem0, Hindsight, Supermemory, ByteRover, OpenViking, RetainDB, holographic) are thin plugins behind the same ABC - Hermes is **memory-backend-agnostic**.

### 2. Learning loop (the actual self-improvement)

`agent/background_review.py`. After a turn, `_run_review_in_thread` spins up a **forked `AIAgent`** that:
- inherits the parent's live runtime (provider/model/base_url/api_key) and the **cached system prompt verbatim** so it hits the same Anthropic/OpenRouter prefix cache (PR #17276 claims ~26% cost reduction);
- runs `skip_memory=True` (no external-provider side effects) but is **re-bound to the parent's built-in `_memory_store`** so its writes still land in `MEMORY.md`/`USER.md`;
- runs with a **runtime tool whitelist** of only `memory` + `skills` tools (`set_thread_tool_whitelist`), everything else denied;
- receives one of three review prompts and acts.

The prompts *are* the learning policy. They're long and opinionated. The **memory** prompt asks "has the user revealed persona/preferences/expectations worth remembering?" The **skill** prompt is the interesting one - it's an explicit curriculum for self-authoring skills:
```
"Review the conversation above and update the skill library. Be ACTIVE - most
 sessions produce at least one skill update ... A pass that does nothing is a
 missed learning opportunity, not a neutral outcome."
```
It encodes a **preference order**: (1) patch a currently-loaded skill, (2) patch an existing umbrella skill, (3) add a `references/`|`templates/`|`scripts/` support file, (4) only then create a new *class-level* umbrella. User frustration/corrections ("stop doing X", "too verbose") are declared **first-class skill signals**, embedded into the SKILL.md body, not just memory. Crucially it carries an explicit **anti-pattern blocklist** - do NOT capture environment-dependent failures, negative claims about tools ("browser tools don't work"), transient errors, or one-off task narratives, because "these harden into refusals the agent cites against itself for months after the actual problem was fixed." This is hard-won prompt engineering: the system is aware that naive self-modification poisons future behavior.

The fork's successful tool actions are summarized back to the user inline: `💾 Self-improvement review: Memory updated · Skill 'x' updated` (`summarize_background_review_actions`).

### 3. Triggers (what fires improvement)

Set in `agent/agent_init.py`, checked in `agent/conversation_loop.py`:
- **Memory review:** turn-based. Default `memory.nudge_interval = 10` → every 10 *user* turns. `_turns_since_memory >= interval` ⇒ `_should_review_memory = True` (conversation_loop.py:552-559).
- **Skill review:** *iteration*-based. Default `skills.creation_nudge_interval = 10` → fires when a single turn used ≥10 tool iterations (i.e. a meaty, multi-step task) and `skill_manage` is available (conversation_loop.py:4697-4702).
- Both spawn **after** the response is delivered, only if `final_response and not interrupted` (4714-4720), so review never competes with the user's task and never blocks the turn.
- Gateway path re-hydrates the counters from prior-turn history (`_user_turn_count`) so a fresh per-message `AIAgent` still reaches the cadence (issue #22357).

There is **no error trigger and no scheduled/cron trigger** for the per-turn review - it is purely turn/iteration cadence + inline.

**Curator** (`agent/curator.py`) is the second, slower loop: an **inactivity-triggered** (not cron) background pass - `maybe_run_curator()` runs when the agent is idle and `last_run_at` is older than `interval_hours` (default **7 days**). It forks an auxiliary-model agent to **consolidate** the skill library (build umbrella skills, archive stale ones) and to auto-transition lifecycle states. Invariants: only touches **agent-created** skills, **never deletes - only archives** (recoverable), pinned skills are exempt.

### 4. Persistence

- All learnings persist as **local files in `~/.hermes/`**: `MEMORY.md`, `USER.md`, `skills/**/SKILL.md`, `skills/.usage.json`, `skills/.curator_state`. Atomic writes (`tempfile` + `os.replace`) with `fcntl`/`msvcrt` locking.
- **Per-profile**, not global: paths resolve through `HERMES_HOME` so profile switches isolate memory/skills.
- Whether it's git-committed is the user's choice (it's just their home dir); nothing in the agent commits or syncs it.
- External-memory persistence lives on the chosen backend's server (Honcho cloud or self-hosted).

### 5. Evaluation - is there a "did this help?"

**No.** This is the key gap vs ax. The loop is **fire-and-forget**:
- No verdict, no scoring, no A/B, no regression check on whether a saved memory or authored skill actually improved later sessions.
- Skill **lifecycle is usage-decay only** (`tools/skill_usage.py`): states are `active → stale (unused > stale_after_days) → archived (unused > archive_after_days)`. "Did anyone use it" is the only signal; "did using it produce a better outcome" is never measured.
- The only thing called a "verdict" in the codebase is a **security scan** verdict (`safe`/`caution`/`dangerous`) applied to skills before install/publish (`tools/skills_guard.py`, `hermes_cli/skills_hub.py`) - efficacy is never evaluated.
- The anti-pattern blocklist in the review prompt is the *only* guard against bad learnings, and it's preventive (a prompt), not evaluative (a measured rollback).

### 6. Boundaries - any cross-agent / federated sharing?

**Almost entirely local. No automatic cross-agent learning.** Evidence:
- The background review and curator write only to the local `~/.hermes/` of that one deployment. Nothing publishes agent-authored skills automatically.
- The **Skills Hub** (`tools/skills_hub.py`, `hermes_cli/skills_hub.py`) is a **one-way, human-gated distribution** channel: `install` pulls from sources `official / github / clawhub / claude-marketplace / lobehub`; `do_publish(skill_path, target)` lets the **user manually** push *one* skill to GitHub (as a PR) or ClawHub (submission), gated by a security scan (`Cannot publish a skill with DANGEROUS verdict`). It is not the self-improvement loop publishing; it's a person deciding to share a curated skill.
- Honcho user-models are per-user/per-peer on a backend the user controls; not shared across users.

So: the *substrate* for sharing exists (skills are portable filesystem packages and there's a publish command + hubs), but the **self-improvement loop never invokes it**, and there is **zero notion of sharing experiments, failures, or recovery patterns** - only finished, human-approved skill artifacts, manually.

---

## hermes-agent vs ax

**Where they agree**
- Both treat **self-authored, file-based knowledge** as the durable unit of improvement (Hermes: `SKILL.md` + `MEMORY.md`/`USER.md`; ax: `.ax/tasks/*.md` briefs + skills + role edges).
- Both **fork/spawn a separate reasoning pass** to do the reflection so it doesn't pollute the main task (Hermes: forked review `AIAgent`; ax: `improve recommend` + `retro` as separate flows).
- Both separate **"who the user is" from "how to do the task"** (Hermes: USER.md vs SKILL.md; ax: intents/preferences vs skill role-weights).
- Both have learned that **naive self-modification is dangerous** and guard against it (Hermes: the prompt blocklist against capturing transient/negative learnings; ax: evidence-grounded verdicts + the "no_longer_needed ambiguity" guard).

**Where they differ**
- **Trigger model.** Hermes is *inline, cadence-based, automatic* (every ~10 turns / ~10 iterations, no human in loop). ax is *transcript-ingest → derived-signal → human/agent-invoked* (`improve recommend`, `/ax:retro`) - slower, more deliberate, evidence-first.
- **Storage.** Hermes = flat markdown files + JSON sidecars, no query layer. ax = SurrealDB graph with FTS recall (`ax recall`), friction/recovery/intent signals, role-weight edges. ax can *ask questions across history*; Hermes can only paste a bounded file into the prompt.
- **Evaluation.** Hermes = none (fire-and-forget; usage-decay lifecycle). ax = the entire point: `verdict at +3/+10/+30 sessions` (adopted/ignored/regressed/partial), evidence-grounded, plus `retro` (tried·worked·failed·next). ax *measures whether a change helped*; Hermes assumes it did.
- **Sharing.** Both local-first, but ax's owner is explicitly designing a **collaborative improvement mesh** (publish experiments + verdicts, esp. failure→recovery, cross-agent/cross-model). Hermes has only manual single-skill publish to hubs and no experiment/verdict object to share.

**What hermes-agent does BETTER (ax should borrow)**
1. **Inline, zero-friction cadence trigger.** Hermes captures a learning *the moment it happens*, automatically, every N turns - no user invocation. ax's loop is deliberate but high-friction; it only learns when someone runs `retro`/`recommend`. A lightweight inline "background review on cadence" would catch learnings ax currently misses.
2. **The review prompt's anti-pattern blocklist.** A battle-tested, explicit list of "do NOT capture" categories (environment failures, negative tool claims, transient errors, one-off narratives). This is exactly the failure mode ax's verdict system tries to catch *after* the fact - Hermes prevents it *at write time*. ax should lift this list verbatim into its recommend/accept guidance.
3. **The skill-update preference ladder + "class-level umbrella" discipline.** "Patch the loaded skill → patch an umbrella → add a support file → only then create new, and never name it after today's task." This directly counters skill-library sprawl, a real risk for ax's growing skill/role graph.
4. **Prefix-cache-preserving fork.** Inheriting the parent's cached system prompt verbatim for the reflection fork (~26% cost claim). If ax ever runs an LLM reflection pass inline, copy this trick.
5. **Memory/skill split as a first-class rule** with the crisp slogan: *memory = "who the user is + current state"; skills = "how to do this class of task for this user"; user-preference corrections belong in the skill body, not just memory.*

**What ax does that hermes-agent does NOT**
- **Evidence/verdict grounding** - the +3/+10/+30 verdict loop and `retro` close the feedback loop Hermes leaves open. ax can answer "did this change help?"; Hermes structurally cannot.
- **A queryable telemetry graph** (friction, recovery, intents, cross-source recall) vs Hermes' bounded paste-the-file memory.
- **A design for cross-agent / cross-model federation of experiments + verdicts** (esp. failure→recovery patterns). Hermes shares only finished, human-approved skill files, manually.

---

## What ax should borrow / avoid (ranked)

1. **Borrow - add an inline, cadence-based capture trigger** alongside the deliberate `retro` loop. Hermes' "every ~10 turns, fork-and-ask 'anything to save?'" closes the gap where a learning is lost because nobody ran `recommend`. Feed the inline capture into ax's *existing* verdict pipeline (capture cheap & automatic, then still grade it) - get Hermes' recall + ax's evaluation.
2. **Borrow - lift Hermes' "do NOT capture" blocklist into ax's recommend/accept guidance** (`agent/background_review.py` `_SKILL_REVIEW_PROMPT`, lines ~124-143). Preventing environment-failure / negative-tool-claim / transient-error learnings at write time is cheaper than catching them at verdict time. Highest ROI, lowest effort.
3. **Borrow - the skill-update preference ladder + class-level-umbrella naming rule** to keep ax's skill/role graph from sprawling into one-shot entries. Encode "patch existing before creating new; never name after today's task" into ax's skill-authoring guidance.
4. **Borrow - the memory↔skill ownership rule** as an explicit ax principle: user-preference corrections update the task-governing skill (durable how-to), not just the user/intent record.
5. **Avoid - Hermes' fire-and-forget evaluation and usage-decay-only lifecycle.** This is precisely ax's differentiator; do not regress toward it. Keep verdicts evidence-grounded; don't let "was it used recently" stand in for "did it help."
6. **Avoid - Hermes' flat-file, no-query memory** as the *primary* store. It's great for a prefix-cache-stable persona snapshot, but ax's graph + FTS recall is strictly more capable; at most adopt a bounded `MEMORY.md`-style frozen snapshot as a *projection* of the graph into the system prompt, not as the store of record.
