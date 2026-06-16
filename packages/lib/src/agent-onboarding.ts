/**
 * @ax/lib re-export of the canonical onboarding prompt (now owned by the
 * zero-dep @ax/onboarding-prompt package) plus the terminal wrapper used by the
 * CLI. Existing consumers (`install.ts` cmdSetup) import from here unchanged.
 */
export {
    AGENT_ONBOARDING_PROMPT,
    AGENT_ONBOARDING_WITH_INSTALL,
    AX_DOCS_URL,
    AX_INSTALL_CMD,
    DASHBOARD_PORT,
} from "@ax/onboarding-prompt";

import { AGENT_ONBOARDING_PROMPT } from "@ax/onboarding-prompt";

/** Prompt wrapped with a short human-facing header for terminal output. */
export const renderAgentOnboarding = (): string =>
    [
        "▸ Hand the rest to your coding agent. Paste this into Claude Code or Codex:",
        "",
        AGENT_ONBOARDING_PROMPT.split("\n")
            .map((l) => (l ? `    ${l}` : ""))
            .join("\n"),
        "",
    ].join("\n");
