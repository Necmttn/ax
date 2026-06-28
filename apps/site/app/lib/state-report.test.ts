import { describe, expect, test } from "bun:test";
import {
    STATE_MIN_USERS,
    hasEnoughStateUsers,
    parseStateYearParam,
    stateRows,
    topStateRows,
} from "./state-report";
import type { StateReport } from "@ax/lib/shared/community";

const report: StateReport = {
    year: 2026,
    users: STATE_MIN_USERS,
    harness_mix: { claude: 20, codex: 10 },
    model_share: { "claude-sonnet": 18, "gpt-5": 7 },
    skill_adoption: Object.fromEntries(
        Array.from({ length: 24 }, (_, i) => [`skill-${String(i).padStart(2, "0")}`, 24 - i]),
    ),
};

describe("state report route helpers", () => {
    test("validates route years and rejects future years", () => {
        expect(parseStateYearParam("2026", { nowYear: 2026 })).toBe(2026);
        expect(parseStateYearParam("2027", { nowYear: 2026 })).toBeNull();
        expect(parseStateYearParam("26", { nowYear: 2026 })).toBeNull();
        expect(parseStateYearParam("2026x", { nowYear: 2026 })).toBeNull();
    });

    test("minimum-N gate opens only once the report has enough users", () => {
        expect(hasEnoughStateUsers({ ...report, users: STATE_MIN_USERS - 1 })).toBe(false);
        expect(hasEnoughStateUsers({ ...report, users: STATE_MIN_USERS })).toBe(true);
    });

    test("stateRows sorts distributions by count desc, then name", () => {
        expect(stateRows({ b: 2, c: 3, a: 2 }).map((r) => r.label)).toEqual(["c", "a", "b"]);
    });

    test("stateRows can use registered users as the percentage denominator", () => {
        expect(stateRows({ claude: 20, codex: 10 }, 25).map((r) => r.share)).toEqual([0.8, 0.4]);
    });

    test("topStateRows caps skill adoption to the top 20", () => {
        const rows = topStateRows(report.skill_adoption, 20);
        expect(rows).toHaveLength(20);
        expect(rows[0]).toMatchObject({ label: "skill-00", count: 24 });
        expect(rows.at(-1)).toMatchObject({ label: "skill-19", count: 5 });
    });
});
