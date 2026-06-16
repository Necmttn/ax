import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AGENT_ONBOARDING_WITH_INSTALL } from "@ax/onboarding-prompt";

describe("landing copy button", () => {
    test("uses the canonical with-install prompt (no inline AGENT_PROMPT literal)", () => {
        const src = readFileSync(
            new URL("./dashboard-preview.tsx", import.meta.url),
            "utf8",
        );
        // The component must consume the shared export, not re-author the prompt.
        expect(src).toContain("AGENT_ONBOARDING_WITH_INSTALL");
        expect(src).not.toMatch(/const AGENT_PROMPT\s*=/);
    });

    test("canonical with-install prompt is the 8-step pre-install variant", () => {
        expect(AGENT_ONBOARDING_WITH_INSTALL).toContain("1. INSTALL - run");
        expect(AGENT_ONBOARDING_WITH_INSTALL).toContain("8. GIVE ME A NEXT STEP");
    });
});
