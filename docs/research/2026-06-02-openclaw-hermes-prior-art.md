# OpenClaw / hermes prior-art for ax's 4 designs

Date: 2026-06-02
Question: ax is designing (1) preference/taste extraction, (2) a community registry,
(3) self-documenting shared artifacts, (4) a collaborative "improvement mesh".
Do OpenClaw, the local `hermes` project, or adjacent prior art already solve these,
and how (exact mechanism)?

Verdict up front: **the first three are well-covered prior art** (taste extraction =
`soul.md`; registries = the awesome-* fork+PR pattern + ClawHub; self-documenting
shares = SOUL.md/skill manifests). **The fourth - a cross-agent improvement mesh that
publishes experiments + verdicts (esp. failure→recovery) for *other* agents to learn
from - is the genuinely open lane.** Everyone's "self-improvement" today is
single-agent and local-only by design.

---

## OpenClaw

OpenClaw (formerly Moltbot/ClawdBot, ~245–347K GitHub stars by Apr 2026) is a
local-first personal AI assistant that answers on the messaging channels you already
use (WhatsApp/Telegram/Slack/Discord/Signal/iMessage/…), with voice + a "Live Canvas"
visual workspace. Repo: https://github.com/openclaw/openclaw - docs:
https://docs.openclaw.ai/ - onboarding via `openclaw onboard`.

Caveat on grounding: the repo `AGENTS.md` and `README.md` are thin on the AI-centric
features (they're mostly channel-list + maintainer architecture guidance - core stays
"plugin-agnostic", skills are plugins under `extensions/`). The real mechanism detail
lives in **skill packages on ClawHub** and the docs/blog, not core source. I've flagged
marketing-vs-implemented where I could.

### SOUL.md - the identity/preference layer
- **What it encodes:** a plain-Markdown "foundational identity layer" - personality,
  communication style, core values, behavioral guardrails. The pitch: "not a chatbot
  that talks about you, but an AI that thinks and speaks *as* you."
- **Where it lives / how loaded:** OpenClaw injects prompt files
  (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, sometimes `IDENTITY.md`/`HEARTBEAT.md`) into the
  agent workspace. Persistent memory + user preferences are stored as **local Markdown
  documents** (deep personalization, hand-tweakable).
- Guide: https://openclaws.io/blog/openclaw-soul-md-guide (note: returned 403 to my
  fetcher; sourced from the search snippet).

### soul.md - the actual taste-extraction pipeline (this is the real prior art for ax design #1)
Repo: https://github.com/aaronjmars/soul.md - "Let Claude Code / OpenClaw ingest your
data & build your AI soul."
- **Ingest:** dump diverse personal corpora into a `data/` folder - X/Bluesky/LinkedIn
  exports, Substack/Medium/blog essays, messaging exports, notes, transcripts, code
  activity, plain text.
- **Pipeline:** agent reads everything → extracts worldview + voice → identifies
  recurring themes, vocabulary, argument structures, philosophical positions → distills
  to structured markdown.
- **Outputs:** `SOUL.md` (identity/worldview/opinions), `STYLE.md` (voice/syntax),
  `MEMORY.md` (session continuity), `examples/` (calibration samples).
- **Quality metric:** a reader of your SOUL.md should be able to **predict your takes on
  new topics**. Explicitly wants *specific* book references, named influences, actual
  hot takes with reasoning - not generic statements.
- This is exactly ax's "taste extraction," but sourced from **published corpora**
  (essays/tweets) rather than ax's source: **agent session transcripts**.

### Self-improvement / "writes its own skills" / long-term memory
- **Marketing claim (openclaw.ai / DigitalOcean writeups):** OpenClaw is "self-improving"
  - it autonomously writes code to create new skills, does proactive automation, and
  keeps long-term memory of user preferences as local Markdown.
- **Real implemented mechanism = a *skill*, not core:** the **Self-Improving Agent**
  skill (https://clawhub.ai/pskoett/self-improving-agent). Exact behavior:
  - Captures three buckets to a local `.learnings/` dir:
    `ERRORS.md` (command failures/integration issues), `LEARNINGS.md`
    (corrections, knowledge gaps, best practices), `FEATURE_REQUESTS.md`.
  - Each entry has a unique ID (`LRN-20250115-001`), priority, status, tags, summary,
    details, suggested actions, related-file refs.
  - **Triggers:** command fails unexpectedly; user corrects ("No, that's wrong…");
    requested capability doesn't exist; external API breaks; knowledge is outdated.
    Optional hook injects a "learning evaluation reminder" after each prompt (~50–100
    tokens).
  - **Scope: locally isolated by default** (`.learnings/` is gitignored to avoid
    committing sensitive/noisy logs). Broadly-applicable lessons can be *manually
    promoted* into shared `CLAUDE.md`/`AGENTS.md`/copilot-instructions. **No automatic
    cross-agent sharing.**
- This maps almost 1:1 to ax's `improve recommend → accept → verdict` + `retro` loop -
  but ax's loop is **graph-backed (SurrealDB) with timed verdicts at +3/+10/+30
  sessions**, whereas the OpenClaw skill is flat markdown with manual promotion. The
  failure→recovery framing ax wants is *present in spirit* (ERRORS.md + corrections) but
  unstructured and never leaves the box.

### Community registries (ax design #2 - the fork-magnet pattern)
Three layers, all real:
- **awesome-openclaw-agents** (mergisi) - https://github.com/mergisi/awesome-openclaw-agents.
  ~162→205 SOUL.md agent templates across 19→24 categories. **Contribution = fork + PR**,
  exact recipe (from CONTRIBUTING.md):
  1. fork+clone; 2. `mkdir -p agents/[category]/[agent-name]`;
  3. required files `SOUL.md` + `README.md`, optional `AGENTS.md`/`HEARTBEAT.md`/`WORKING.md`;
  4. **add a manifest entry to `agents.json`** (`id, category, name, role, path, deploy`);
  5. PR checklist (template-conformant SOUL.md, README present, agents.json entry,
     functionality verified, no broken links).
  - On merge: rendered to the GitHub registry **and** auto-listed on a hosted gallery
    (`crewclaw.com/agents`) with a **deploy button**; full-file submissions get a
    "Full Agent OS" tier badge. This is the raycast-extensions fork-magnet pattern ax
    wants: **unit = a directory + a manifest row, gallery auto-renders on merge.**
- **awesome-openclaw-skills** (VoltAgent) - https://github.com/VoltAgent/awesome-openclaw-skills.
  ~5,211 curated skills. Different rule: skills must **already exist on ClawHub**; the PR
  only adds the **ClawHub link** (`https://clawhub.ai/<author>/<slug>`) to a categorized
  markdown file. "We do not accept links to personal repos, gists, or any other source."
  So the awesome-list is a *curation layer over a real package registry*, not the store.
- **ClawHub** - https://clawhub.ai - the actual skills package registry (~2,857–5,000+
  skills). `clawhub install <slug>` → `~/.openclaw/skills/` or `<project>/skills/`. This
  is the npm-equivalent; the awesome-* lists are the human-curated index on top.

### OpenClaw-RL (ax design #4 - closest thing to a "mesh," but isn't one)
Repo: https://github.com/Gen-Verse/OpenClaw-RL - "train any agent by talking."
- Async RL framework: wraps your self-hosted model in OpenClaw as an OpenAI-compatible
  API, **intercepts live multi-turn conversations**, and continuously optimizes the
  policy in the background. Uses "the next user/environment/tool feedback as a natural
  next-state signal," organizing turns into "session-aware training trajectories" - no
  manual labeling.
- Supports optimizing one model from a **group of people's** feedback.
- **Not a mesh:** "Conversation data stays within your system." It's single-model
  personalization (many users → one model), **no peer-to-peer agent/node experience or
  verdict sharing.** This is the closest adjacent work to ax's improvement mesh and it
  *deliberately stops at the box boundary* - which is exactly the gap ax can own.

### Stars / feedback / telemetry
- Onboarding is `openclaw onboard` (QuickStart vs Advanced) configuring gateway,
  channels, skills, workspace. **No documented "star the repo" nudge or telemetry
  collection in the CLI flow** found in docs/README - its 245K+ stars appear
  organic/viral, not CLI-prompted. (Absence of evidence, not proven absence.)

---

## hermes

Two things share the name; don't conflate them.

### The local dir `/Users/necmttn/Projects/balicontent/hermes/` = a deploy wrapper
It's a **git submodule + Coolify/Docker deployment of NousResearch's `hermes-agent`**,
customized for "ContentDrop" (a Bali content-creation ops business). Contents:
- `Dockerfile`: `git clone --recurse-submodules https://github.com/NousResearch/hermes-agent.git`,
  pip-installs it, also installs `@anthropic-ai/claude-code` globally.
- `SOUL.md`: a **ContentDrop ops-agent persona** - monitors a Postgres `leads`/`bookings`
  DB, notifies the team on Telegram about new orders/deadlines, tracks a booking status
  flow (New → … → Delivered). (Same SOUL.md concept as OpenClaw - confirms the pattern is
  cross-ecosystem.)
- `config.yaml`: OpenRouter model (`qwen3.6-plus`), `memory.enabled: true`,
  `context_compression.enabled: true` (trigger_ratio 0.5), platform toolsets per channel,
  a Postgres MCP server.
- `entrypoint.sh`: creates `$HERMES_HOME/{cron,sessions,logs,hooks,memories,skills,bin}`,
  runs `tools/skills_sync.py`, runs `hermes gateway run`. Memory/sessions/skills persist
  on a named Docker volume across redeploys.
- `skills/brand/…` = custom skills (brand-check, brand-domain-search) baked in.
- **This dir itself contributes no novel architecture** beyond "deploy hermes-agent with
  a custom soul + a Postgres MCP." It's a concrete usage example, not prior art per se.

### The upstream `NousResearch/hermes-agent` = the real comparable
Repo: https://github.com/NousResearch/hermes-agent - "a self-improving AI agent that
creates skills from experience, improves them during use," single gateway process across
Telegram/Discord/Slack/WhatsApp/Signal/CLI. Architecture (from repo README):
- **Memory:** persistent memory with **user profiles**; **FTS5 (SQLite) session search +
  LLM summarization for cross-session recall**; integrates **Honcho dialectic user
  modeling** to learn user preferences over time. This is the strongest hermes overlap
  with ax: *learning user preferences from sessions, with cross-session recall.* Storage =
  local SQLite + the `memories/`/`sessions/` dirs (vs ax's SurrealDB graph).
- **Skills = procedural memory:** **autonomous skill creation after complex tasks**;
  "skills self-improve during use"; compatible with the **agentskills.io open standard**;
  browsable via slash commands. So hermes *also writes its own skills*, like OpenClaw.
- **Self-improvement loop:** built-in learning loop + agent-curated memory with "periodic
  nudges."
- **Cron / sessions / subagents:** built-in cron scheduler (daily reports, nightly
  backups), interruptible/redirectable sessions, isolated subagents for parallel work,
  MCP integration.

**What hermes-agent has of ax's 4:** preference/taste extraction ✅ (Honcho user
modeling + profiles), a memory/recall layer ✅ (FTS5, but **search index, not a derived
signal graph** - no friction/recovery/intent edges), a self-improvement loop ✅ (local).
**What it lacks:** a *community* registry of profiles (it consumes agentskills.io, doesn't
run its own taste registry), session *sharing*, and any **cross-agent experience/verdict
mesh** (all memory is per-deployment/local). Same boundary as everyone else.

**What ax could learn from hermes:** (a) **Honcho dialectic user modeling** is a
purpose-built "theory-of-mind / user-preference" engine - worth evaluating as a
preference-extraction backend or at least a schema reference; (b) FTS5 + LLM summarization
is a cheap, proven cross-session recall recipe (ax already has `ax recall`; hermes
validates the summarize-then-index shape); (c) "procedural memory = skills auto-created
after complex tasks" is a cleaner framing than ax's recommend/accept brief flow for the
*capture* step.

---

## Adjacent prior art

- **Continue Hub** - https://www.continue.dev/hub?type=rules - hosted registry of
  shareable **rule blocks** (+ models/MCP/assistants); author via hub.continue.dev "New
  Block → Rules"; also a fork+PR `awesome-rules` list
  (https://github.com/continuedev/awesome-rules). Closest "rules sharing" analog to ax's
  taste-profile registry; has both a hosted hub *and* an awesome-list, like OpenClaw.
- **Smithery** - https://smithery.ai - 6,000+ community-submitted **MCP servers** with
  registry search API + CLI (`smithery-ai/cli`). Pattern: package registry + searchable
  index; quality varies (curation problem ax should anticipate).
- **agentskills.io** - the open skill standard hermes-agent targets; the
  interoperability layer beneath both ClawHub and hermes skills.
- **CrewClaw** (https://crewclaw.com) - the hosted auto-render/deploy gallery that sits on
  top of awesome-openclaw-agents; concrete example of "merge a PR → it shows up deployable
  in a gallery."

---

## How this maps to ax's 4 designs

| ax design | Strongest prior art (mechanism + link) | What's genuinely novel for ax | What ax should borrow |
|---|---|---|---|
| **1. Taste/preference extraction** | `soul.md` ingest→distill pipeline (data/ → SOUL.md/STYLE.md/MEMORY.md), "predict your takes" quality bar - https://github.com/aaronjmars/soul.md; hermes Honcho user modeling + FTS5 recall | ax mines **agent session transcripts + telemetry** (tools/skills actually invoked, friction/recovery events), not published essays/tweets. Behavioral taste, not stated taste. | The "predict your next take" output quality bar; STYLE/MEMORY split; consider Honcho as a preference backend/schema. |
| **2. Community registry** | awesome-openclaw-agents fork+PR + `agents.json` manifest + auto-rendered deploy gallery (crewclaw) - https://github.com/mergisi/awesome-openclaw-agents; VoltAgent-over-ClawHub curation layer; Continue Hub | Unit of contribution = a **taste-profile / telemetry-derived play**, not a hand-written persona. Could ship *with evidence* (usage counts, verdicts) baked in. | The exact fork+PR+manifest+gallery loop. `agents.json`-style manifest + a hosted render-on-merge gallery is the proven fork-magnet. Don't reinvent. |
| **3. Self-documenting shares** | SOUL.md/skill packages are self-describing markdown; ClawHub install slugs; agents.json `deploy` field - https://clawhub.ai | `ax share` = a **session** (a temporal artifact), not a static profile. "Links back + explains itself" is under-served by prior art (profiles are static). | Embed a manifest + provenance + a one-line "why this matters" in the gist, like a SOUL.md README; make it `install`-able by slug. |
| **4. Improvement mesh (publish experiments + verdicts, cross-agent learning of failure→recovery)** | **Nobody does this.** Closest: OpenClaw-RL intercepts conversations to train *one* model ("data stays within your system" - https://github.com/Gen-Verse/OpenClaw-RL); self-improving skill keeps `.learnings/` **local**; hermes memory is per-deployment | **This is ax's open lane.** A protocol for agents/nodes to publish `{experiment, verdict, failure→recovery}` and *consume* others' - cross-agent, cross-model - has no real prior art. | Borrow the *capture* schema (ERRORS/LEARNINGS entry IDs, verdict timing) but the *sharing/mesh* layer is yours to define. |

---

## Takeaways for ax (ranked)

1. **Lead with the improvement mesh (design #4) - it's the only un-owned lane.** Every
   comparable ("self-improving" OpenClaw skill, hermes learning loop, OpenClaw-RL) is
   **single-agent and local by deliberate design** ("data stays within your system",
   `.learnings/` gitignored). A protocol that publishes experiments + **failure→recovery
   verdicts** for *other* agents to learn from is genuinely novel. Differentiate here, not
   on taste extraction.
2. **Copy the registry loop verbatim - don't design it.** fork + PR + a `agents.json`-style
   **manifest row** + **auto-render-on-merge to a hosted deployable gallery** (mergisi →
   crewclaw) is the proven raycast-style fork-magnet. ax's twist: each entry carries
   **evidence** (usage counts, verdicts) the persona registries can't.
3. **Reframe taste extraction as behavioral, and steal soul.md's output bar.** soul.md
   mines *stated* taste (essays/tweets); ax mines *revealed* taste (what tools/skills you
   actually invoke, where you hit friction). Keep soul.md's "a reader should predict your
   next take" quality metric and its SOUL/STYLE/MEMORY file split as the output contract.
4. **Evaluate Honcho (via hermes) before building preference modeling from scratch.**
   hermes-agent already wires Honcho dialectic user-modeling + FTS5 session recall for
   "learn user preferences over time." At minimum a schema reference; possibly a backend.
5. **Make `ax share` install-able + provenance-stamped, like a ClawHub slug.** Prior art
   shares *static* personas; ax shares a *session*. Bake a manifest + "why this matters"
   line + a back-link so the gist self-documents and can be `install`ed by slug.
6. **Trap to avoid: the curation/quality cliff.** Smithery (6k servers) and ClawHub (5k+
   skills) show fork-magnet registries fill with low-quality entries fast. ax's
   evidence-carrying entries (real usage/verdict data) are a *natural* quality filter -
   make that ranking signal first-class from day one, or the registry rots like the rest.
