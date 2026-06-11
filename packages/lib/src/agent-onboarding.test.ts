import { describe, expect, test } from "bun:test";
import { AGENT_ONBOARDING_PROMPT, renderAgentOnboarding } from "./agent-onboarding.ts";
import { DEFAULT_DASHBOARD_PORT } from "./dashboard-port.ts";

describe("agent-onboarding dashboard port", () => {
    test("onboarding prompt points at the serve default port", () => {
        // Anti-drift guard for issue #268: the prompt agents paste verbatim
        // must reference the same port `ax serve` actually binds by default.
        expect(AGENT_ONBOARDING_PROMPT).toContain(`http://127.0.0.1:${DEFAULT_DASHBOARD_PORT}`);
    });

    test("no stale port references survive in the rendered onboarding", () => {
        expect(renderAgentOnboarding()).not.toContain("8520");
    });
});
