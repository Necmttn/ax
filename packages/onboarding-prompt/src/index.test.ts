import { describe, expect, test } from "bun:test";
import {
    AGENT_ONBOARDING_PROMPT,
    AGENT_ONBOARDING_WITH_INSTALL,
    AX_INSTALL_CMD,
    AX_DOCS_URL,
    DASHBOARD_PORT,
} from "./index.ts";

describe("onboarding prompt - canonical content", () => {
    test("body opens with the local-and-reviewed framing", () => {
        expect(AGENT_ONBOARDING_PROMPT).toContain("it runs locally and I review every change");
    });

    test("body carries the founder feedback note", () => {
        expect(AGENT_ONBOARDING_PROMPT).toContain("A note from Neco (ax's founder)");
    });

    test("body defines the CONTRIBUTE-BACK block once", () => {
        const count = AGENT_ONBOARDING_PROMPT.split("CONTRIBUTE-BACK (do this whenever").length - 1;
        expect(count).toBe(1);
    });

    test("body has a reality-check beat naming verification as the seeded blind-spot", () => {
        expect(AGENT_ONBOARDING_PROMPT).toContain("does this match how I actually work");
        expect(AGENT_ONBOARDING_PROMPT).toContain("verification often hides");
    });

    test("body opens with the local-only PRIVACY preamble (read first)", () => {
        expect(AGENT_ONBOARDING_PROMPT).toContain("PRIVACY (read first");
        expect(AGENT_ONBOARDING_PROMPT).toContain("no outbound call at ingest");
        // The privacy guard must explicitly fence off outbound profile commands.
        expect(AGENT_ONBOARDING_PROMPT).toContain("Do NOT run `ax profile publish`");
        expect(AGENT_ONBOARDING_PROMPT).toContain("or `ax profile widget`");
    });

    test("body carries the value-tour and parallel-insight steps", () => {
        expect(AGENT_ONBOARDING_PROMPT).toContain("BUILD MY PROFILE + AGENT WRAPPED");
        expect(AGENT_ONBOARDING_PROMPT).toContain("ax wrapped generate");
        expect(AGENT_ONBOARDING_PROMPT).toContain("GATHER MY INSIGHTS IN PARALLEL");
        expect(AGENT_ONBOARDING_PROMPT).toContain("MOST CAPABLE / strongest-reasoning model");
    });

    test("body points at the serve dashboard port", () => {
        expect(AGENT_ONBOARDING_PROMPT).toContain(`http://127.0.0.1:${DASHBOARD_PORT}`);
    });

    test("body is the 7-step post-install variant (no INSTALL step)", () => {
        expect(AGENT_ONBOARDING_PROMPT).toContain("1. INGEST MY HISTORY");
        expect(AGENT_ONBOARDING_PROMPT).toContain("7. GIVE ME A NEXT STEP");
        expect(AGENT_ONBOARDING_PROMPT).not.toContain("INSTALL - run");
    });

    test("with-install variant prepends the install step and renumbers to 8", () => {
        expect(AGENT_ONBOARDING_WITH_INSTALL).toContain(`1. INSTALL - run \`${AX_INSTALL_CMD}\``);
        expect(AGENT_ONBOARDING_WITH_INSTALL).toContain(AX_DOCS_URL);
        expect(AGENT_ONBOARDING_WITH_INSTALL).toContain("2. INGEST MY HISTORY");
        expect(AGENT_ONBOARDING_WITH_INSTALL).toContain("8. GIVE ME A NEXT STEP");
    });

    test("with-install shares the same body steps as the canonical prompt", () => {
        // Every numbered step body in the post-install prompt (everything after
        // its leading "N. ") must also appear verbatim in the with-install
        // variant, proving both derive from one STEPS source.
        const bodies = AGENT_ONBOARDING_PROMPT.split("\n\n")
            .filter((p) => /^\d+\. /.test(p))
            .map((p) => p.replace(/^\d+\. /, ""));
        expect(bodies.length).toBe(7);
        for (const body of bodies) {
            expect(AGENT_ONBOARDING_WITH_INSTALL).toContain(body);
        }
    });

    test("no em-dashes survive (repo hook rewrites them; assert ASCII)", () => {
        expect(AGENT_ONBOARDING_WITH_INSTALL).not.toContain("\u2014");
    });
});
