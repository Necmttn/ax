import { describe, expect, test } from "bun:test";
import { DASHBOARD_PORT as PROMPT_PORT } from "@ax/onboarding-prompt";
import { AGENT_ONBOARDING_PROMPT, renderAgentOnboarding } from "./agent-onboarding.ts";
import { DEFAULT_DASHBOARD_PORT } from "./dashboard-port.ts";

describe("agent-onboarding dashboard port", () => {
    test("onboarding prompt points at the serve default port", () => {
        // Anti-drift guard for issue #268: the prompt agents paste verbatim
        // must reference the same port `ax serve` actually binds by default.
        expect(AGENT_ONBOARDING_PROMPT).toContain(`http://127.0.0.1:${DEFAULT_DASHBOARD_PORT}`);
    });

    test("micro-package port matches @ax/lib serve default", () => {
        // The zero-dep package inlines the port; this asserts it can't drift
        // from the single source in dashboard-port.ts.
        expect(PROMPT_PORT).toBe(DEFAULT_DASHBOARD_PORT);
    });

    test("no stale port references survive in the rendered onboarding", () => {
        expect(renderAgentOnboarding()).not.toContain("8520");
    });
});
