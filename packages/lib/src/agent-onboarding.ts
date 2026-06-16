/**
 * The "give this to your agent" onboarding prompt - ax's parallel to
 * effect.solutions' "Copy Agent Instructions". Single source of truth consumed
 * by the CLI (`ax setup [--agent-prompt]`), install.sh (via the binary), and the
 * landing site's copy button. Drives the agent through ingest -> verify -> LABEL
 * (the classify/lint loop) -> a value tour: profile/wrapped on the main agent,
 * then a parallel fan-out that dispatches cheap GATHER subagents for cost /
 * friction / history while the main (strongest) model keeps the judgment.
 */

import { DEFAULT_DASHBOARD_PORT } from "./dashboard-port.ts";

/** The raw prompt text the user pastes into Claude Code / Codex. */
export const AGENT_ONBOARDING_PROMPT = [
    "Set up ax for me. ax is my local agent-experience graph over my Claude Code + Codex history. Do this end to end:",
    "",
    "PRIVACY (read first, so you can answer if I ask whether this is safe to run): ax is fully local. Ingest reads my transcripts, git history, and tool calls into a SurrealDB on 127.0.0.1 - nothing is uploaded, there is no account, no cloud, and no outbound call at ingest. The ONLY thing that can ever leave my machine is `ax profile publish`, which is opt-in and consent-gated: it shares an aggregates-only JSON (counts, day streaks, model split, skill/hook names, taste-pattern summaries) to a public gist I control - NEVER transcript content, code, project names, or file paths. `--no-cost` strips the dollar figures too, and `ax profile unpublish` deletes it. Do NOT run `ax profile publish` as part of this setup. If I ask about privacy or data handling, answer from these facts; it's AGPL-3.0, so you can also read the source to confirm.",
    "",
    `1. INGEST MY HISTORY - first run \`ax ingest --dry-run\` and tell me, in plain words, how long a full backfill will take. Then start the ingest in the BACKGROUND so we can keep working: run \`ax ingest\` as a background job with AX_PROGRESS=plain, and watch its output for progress and completion. Tell me I can watch it fill live in the dashboard - run \`ax serve\` and open http://127.0.0.1:${DEFAULT_DASHBOARD_PORT}. When the ingest finishes, summarize what landed: total sessions, turns, and the top skills/tools I actually use. Then continue with the steps below.`,
    "",
    "2. VERIFY - run `ax doctor`. If anything isn't ok, diagnose and fix it, then re-run until it is.",
    "",
    "3. LABEL what ax can't classify - run `ax skills classify`. It writes one `.ax/tasks/classify-<skill>.md` brief per skill I use but ax can't role-tag. For each brief: read the skill, decide its role(s), and fill the YAML frontmatter at the top (`primary_role:` is required; `secondary`, `confidence`, `rationale` are optional). Run `ax roles` to see labels already in use. Then run `ax skills lint` to apply them. If it says \"no unclassified skills\", that's fine - nothing to label yet.",
    "",
    "4. SHOW me the result - run `ax skills weighted` (usage x role ranking) and `ax skills config` (lifecycle view). Tell me which skills you labeled and why, and flag anything ax marked orphan or out-of-scope.",
    "",
    "5. BUILD MY PROFILE + AGENT WRAPPED - first run `ax profile show` for a quick text fingerprint (sessions, active days + streak, model split, top skills, installed hooks, workflow arcs, taste patterns) and read it back to me in a few sentences. THEN build my Agent Wrapped deck, because the dashboard's Wrapped tab stays BLANK until you do - ingest does not fill it. Run `ax wrapped generate`; it writes a brief to `.ax/tasks/wrapped-generate-<date>.md`. Follow that brief: mine my graph for the answers and assemble the recap cards as `{ \"cards\": [{question, headline, body, sensitivity?}] }` JSON, then publish them with `ax wrapped publish --file=<your-cards.json>` (or pipe the JSON on stdin). Now my Wrapped deck is populated - tell me to run `ax serve` and open http://127.0.0.1:1738 to see it. All of this stays LOCAL: `ax profile show` and `ax wrapped publish` write only to my own machine and upload nothing. Do NOT run `ax profile publish` (that is the one command that leaves my machine).",
    "",
    "6. GATHER MY INSIGHTS IN PARALLEL - the three areas below are independent and only READ the local graph, so fan them out instead of running them one by one: dispatch one subagent per area, all at once (cap ~3 concurrent - they share one local SurrealDB). Put these GATHER subagents on a CHEAP model (claude-sonnet-4-6, or claude-haiku-4-5 for the lightest) - running fixed read-only commands and pasting back the output is mechanical, and routing it down dogfoods ax's own cost lens. Each subagent ONLY runs its commands and returns the raw output plus a short factual summary; it makes NO decisions. Keep all the JUDGMENT on yourself, the strongest model - do not delegate the thinking. The areas: (a) SPEND - `ax cost sessions`, `ax cost routability`, `ax dispatches --candidates`; (b) FRICTION - `ax improve recommend`, `ax insights friction`, `ax insights tools`; (c) HISTORY (run inside one of my git repos) - `ax sessions here --days=30`, `ax recall \"<a topic worth searching>\"`. When all three return, YOU synthesize: my single biggest cost driver and the largest concrete saving, the top 1-2 fixes worth accepting and why (if I say yes, run `ax improve accept <id>` then `ax improve lint`), and one genuinely useful thing from my history.",
    "",
    "7. GIVE ME A NEXT STEP - recommend 1-2 under-used skills you'd reach for based on what you saw, then end with a concrete CTA: the exact command or prompt I should run next, and what outcome it will produce.",
].join("\n");

/** Prompt wrapped with a short human-facing header for terminal output. */
export const renderAgentOnboarding = (): string =>
    [
        "▸ Hand the rest to your coding agent. Paste this into Claude Code or Codex:",
        "",
        AGENT_ONBOARDING_PROMPT
            .split("\n")
            .map((l) => (l ? `    ${l}` : ""))
            .join("\n"),
        "",
    ].join("\n");
