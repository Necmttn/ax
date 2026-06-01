import { describe, expect, test } from "bun:test";
import { shortSessionId, toBareSessionId, toSessionRid } from "./session-id.ts";

describe("toBareSessionId", () => {
    test("strips backtick-wrapped record-id form", () => {
        expect(toBareSessionId("session:`019e2531-b552-7b53-a029-c780adbb6560`"))
            .toBe("019e2531-b552-7b53-a029-c780adbb6560");
    });

    test("strips angle-bracket record-id form", () => {
        expect(toBareSessionId("session:⟨019e2531-b552-7b53-a029-c780adbb6560⟩"))
            .toBe("019e2531-b552-7b53-a029-c780adbb6560");
    });

    test("strips unquoted session: prefix", () => {
        expect(toBareSessionId("session:abc123")).toBe("abc123");
    });

    test("idempotent on bare uuid", () => {
        const uuid = "019e2531-b552-7b53-a029-c780adbb6560";
        expect(toBareSessionId(uuid)).toBe(uuid);
        expect(toBareSessionId(toBareSessionId(uuid))).toBe(uuid);
    });

    test("idempotent on bare claude-subagent id", () => {
        const id = "claude-subagent-a1f6ef32d7aefc7b9";
        expect(toBareSessionId(id)).toBe(id);
    });

    test("handles leading/trailing whitespace", () => {
        expect(toBareSessionId("  session:`abc-def`  ")).toBe("abc-def");
    });

    test("returns empty string for empty input", () => {
        expect(toBareSessionId("")).toBe("");
    });

    test("strips only one layer of session: prefix (single-stripped)", () => {
        // Defensive: if a double-prefixed string ever appears we strip the
        // outermost layer once. The inner `session:` survives so the bug is
        // visible upstream rather than silently swallowed.
        expect(toBareSessionId("session:session:abc")).toBe("session:abc");
    });
});

describe("toSessionRid", () => {
    test("wraps a uuid (hyphens) in backticks", () => {
        const uuid = "019e2531-b552-7b53-a029-c780adbb6560";
        expect(toSessionRid(uuid)).toBe(`session:\`${uuid}\``);
    });

    test("wraps a claude-subagent id (hyphens) in backticks", () => {
        const id = "claude-subagent-a1f6ef32d7aefc7b9";
        expect(toSessionRid(id)).toBe(`session:\`${id}\``);
    });

    test("does not wrap pure alphanumeric ids", () => {
        expect(toSessionRid("abc123")).toBe("session:abc123");
    });

    test("does not wrap alphanumeric + underscore", () => {
        expect(toSessionRid("abc_123")).toBe("session:abc_123");
    });

    test("strips embedded backticks defensively before wrapping", () => {
        // An id with embedded backticks would break the SurrealQL parser;
        // strip them rather than emit a syntactically broken record-id.
        expect(toSessionRid("abc`def-ghi")).toBe("session:`abcdef-ghi`");
    });
});

describe("shortSessionId", () => {
    test("returns the first 12 chars of a bare uuid", () => {
        expect(shortSessionId("019e2531-b552-7b53-a029-c780adbb6560"))
            .toBe("019e2531-b55");
    });

    test("returns the first 12 chars of a claude-subagent id", () => {
        expect(shortSessionId("claude-subagent-a1f6ef32d7aefc7b9"))
            .toBe("claude-subag");
    });

    test("passes short ids through unchanged", () => {
        expect(shortSessionId("abc")).toBe("abc");
    });
});

describe("round-trip wire shape", () => {
    test("toBareSessionId ∘ toSessionRid is identity on bare ids", () => {
        const cases = [
            "019e2531-b552-7b53-a029-c780adbb6560",
            "claude-subagent-a1f6ef32d7aefc7b9",
            "abc123",
            "abc_def_123",
        ];
        for (const id of cases) {
            expect(toBareSessionId(toSessionRid(id))).toBe(id);
        }
    });
});
