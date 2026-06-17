// apps/axctl/src/dojo/format.test.ts
import { describe, expect, test } from "bun:test";
import type { DojoAgenda } from "./schema.ts";
import { renderAgenda } from "./format.ts";

const agenda: DojoAgenda = {
    v: 1,
    generated_at: "2026-06-13T10:00:00.000Z",
    budget: {
        has_surplus: true, spendable_pct: 20, binding_window: "five_hour",
        window_remaining_pct: 35, reserve_pct: 15,
        deadline: "2026-06-13T12:00:00.000Z", source: "quota",
    },
    source_failures: [],
    items: [
        {
            id: "verdict:experiment:aaa", kind: "verdict_pending",
            title: "Lock verdict: Stop bare bun test",
            commands: ["ax improve verdict aaa"], success: "locked", cost_class: "s",
        },
    ],
};

describe("renderAgenda", () => {
    test("renders budget line + item rows", () => {
        const out = renderAgenda(agenda);
        expect(out).toContain("budget: 20% spendable (5h window, 35% left, 15% reserve)");
        expect(out).toContain("deadline 2026-06-13T12:00");
        expect(out).toContain("1. [verdict_pending/s] Lock verdict: Stop bare bun test");
        expect(out).toContain("   $ ax improve verdict aaa");
        expect(out).toContain("   done when: locked");
    });

    test("null binding window renders the no-window label", () => {
        const out = renderAgenda({
            ...agenda,
            budget: { ...agenda.budget, binding_window: null },
        });
        expect(out).toContain("budget: 20% spendable (no window, 35% left, 15% reserve)");
    });

    test("no-surplus agenda warns about --force", () => {
        const out = renderAgenda({
            ...agenda,
            budget: { ...agenda.budget, has_surplus: false, spendable_pct: 0 },
        });
        expect(out).toContain("no surplus");
        expect(out).toContain("--force");
    });

    test("source failures are visible in human output", () => {
        const out = renderAgenda({
            ...agenda,
            source_failures: [{ source: "churn", message: "db offline" }],
        });
        expect(out).toContain("degraded sources: churn");
    });
});
