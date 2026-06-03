/**
 * The "give this to your agent" onboarding prompt - ax's parallel to
 * effect.solutions' "Copy Agent Instructions". Single source of truth consumed
 * by the CLI (`ax setup [--agent-prompt]`), install.sh (via the binary), and the
 * landing site's copy button. Drives the agent through verify -> LABEL (the
 * classify/lint loop) -> explore.
 */

/** The raw prompt text the user pastes into Claude Code / Codex. */
export const AGENT_ONBOARDING_PROMPT = [
    "Set up ax for me. ax is my local agent-experience graph over my Claude Code + Codex history. Do this end to end:",
    "",
    "1. VERIFY - run `ax doctor`. If anything isn't ok, diagnose and fix it, then re-run until it is.",
    "",
    "2. LABEL what ax can't classify - run `ax skills classify`. It writes one `.ax/tasks/classify-<skill>.md` brief per skill I use but ax can't role-tag. For each brief: read the skill, decide its role(s), and fill the YAML at the bottom (`primary_role:` is required; `secondary_roles`, `confidence`, `rationale` are optional). Run `ax roles` to see labels already in use. Then run `ax skills lint` to apply them. If it says \"no unclassified skills\", that's fine - nothing to label yet.",
    "",
    "3. SHOW me the result - run `ax skills weighted` (usage x role ranking) and `ax skills config` (lifecycle view). Tell me which skills you labeled and why, and flag anything ax marked orphan or out-of-scope.",
    "",
    "Then recommend a couple of skills I under-use that you'd reach for, based on what you saw.",
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
