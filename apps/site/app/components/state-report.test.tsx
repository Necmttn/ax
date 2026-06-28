import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { STATE_MIN_USERS } from "../lib/state-report";
import { StateReportDossier } from "./state-report";
import type { StateReport } from "@ax/lib/shared/community";

const publicReport: StateReport = {
    year: 2026,
    users: STATE_MIN_USERS,
    harness_mix: { claude: 22, codex: 13 },
    model_share: { "claude-sonnet": 19, "gpt-5": 8 },
    skill_adoption: {
        tdd: 18,
        "agent-browser": 11,
        "writing-plans": 9,
    },
};

function render(report: StateReport): string {
    return renderToStaticMarkup(<StateReportDossier report={report} />);
}

describe("StateReportDossier", () => {
    test("renders measured charts once the minimum-N gate is met", () => {
        const html = render(publicReport);
        expect(html).toContain("measured, not asked");
        expect(html).toContain("Harness mix");
        expect(html).toContain("Model share");
        expect(html).toContain("Skill adoption top 20");
        expect(html).toContain("claude");
        expect(html).toContain("gpt-5");
        expect(html).toContain("agent-browser");
        expect(html).toContain("st-bar");
        expect(html).not.toContain("Founding sample");
    });

    test("renders teaser CTA below the minimum-N gate instead of charts", () => {
        const html = render({ ...publicReport, users: STATE_MIN_USERS - 1 });
        expect(html).toContain("Founding sample");
        expect(html).toContain("ax profile publish");
        expect(html).toContain(`${STATE_MIN_USERS - 1}`);
        expect(html).toContain(`${STATE_MIN_USERS}`);
        expect(html).not.toContain("st-bar");
    });
});
