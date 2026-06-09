import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
    PR_LIST_JSON_FIELDS,
    fetchPullRequests,
    parsePrListOutput,
    prListArgs,
} from "./github-pr-fetch.ts";

describe("PR_LIST_JSON_FIELDS", () => {
    test("is a non-empty comma-joined string", () => {
        expect(typeof PR_LIST_JSON_FIELDS).toBe("string");
        expect(PR_LIST_JSON_FIELDS.length).toBeGreaterThan(0);
        expect(PR_LIST_JSON_FIELDS).toContain(",");
    });

    test("includes all required fields", () => {
        const fields = PR_LIST_JSON_FIELDS.split(",");
        for (const field of [
            "number",
            "title",
            "state",
            "baseRefName",
            "headRefName",
            "headRefOid",
            "mergeCommit",
            "author",
            "url",
            "createdAt",
            "closedAt",
            "mergedAt",
            "additions",
            "deletions",
            "changedFiles",
            "labels",
            "reviews",
            "statusCheckRollup",
        ]) {
            expect(fields).toContain(field);
        }
    });

    test("omits the `commits` field (GraphQL node-limit blowup at scale)", () => {
        expect(PR_LIST_JSON_FIELDS.split(",")).not.toContain("commits");
    });
});

describe("prListArgs", () => {
    test("returns expected argv structure", () => {
        const args = prListArgs(50);
        expect(args[0]).toBe("pr");
        expect(args[1]).toBe("list");
    });

    test("does not include 'gh' itself", () => {
        const args = prListArgs(50);
        expect(args).not.toContain("gh");
    });

    test("includes --state all", () => {
        const args = prListArgs(50);
        const stateIdx = args.indexOf("--state");
        expect(stateIdx).toBeGreaterThanOrEqual(0);
        expect(args[stateIdx + 1]).toBe("all");
    });

    test("includes --json with PR_LIST_JSON_FIELDS", () => {
        const args = prListArgs(50);
        const jsonIdx = args.indexOf("--json");
        expect(jsonIdx).toBeGreaterThanOrEqual(0);
        expect(args[jsonIdx + 1]).toBe(PR_LIST_JSON_FIELDS);
    });

    test("includes --limit with the provided value", () => {
        const args = prListArgs(50);
        const limitIdx = args.indexOf("--limit");
        expect(limitIdx).toBeGreaterThanOrEqual(0);
        expect(args[limitIdx + 1]).toBe("50");
    });

    test("clamps limit: 0 → 1", () => {
        const args = prListArgs(0);
        const limitIdx = args.indexOf("--limit");
        expect(args[limitIdx + 1]).toBe("1");
    });

    test("clamps limit: negative → 1", () => {
        const args = prListArgs(-999);
        const limitIdx = args.indexOf("--limit");
        expect(args[limitIdx + 1]).toBe("1");
    });

    test("clamps limit: 99999 → 1000", () => {
        const args = prListArgs(99999);
        const limitIdx = args.indexOf("--limit");
        expect(args[limitIdx + 1]).toBe("1000");
    });

    test("accepts limit exactly at boundary: 1", () => {
        const args = prListArgs(1);
        const limitIdx = args.indexOf("--limit");
        expect(args[limitIdx + 1]).toBe("1");
    });

    test("accepts limit exactly at boundary: 1000", () => {
        const args = prListArgs(1000);
        const limitIdx = args.indexOf("--limit");
        expect(args[limitIdx + 1]).toBe("1000");
    });

    test("truncates fractional values", () => {
        const args = prListArgs(25.9);
        const limitIdx = args.indexOf("--limit");
        expect(args[limitIdx + 1]).toBe("25");
    });
});

describe("parsePrListOutput", () => {
    test("valid JSON array returns the parsed array", () => {
        const input = JSON.stringify([{ number: 1 }, { number: 2 }]);
        const result = parsePrListOutput(input);
        expect(result).toEqual([{ number: 1 }, { number: 2 }]);
    });

    test("empty JSON array returns []", () => {
        expect(parsePrListOutput("[]")).toEqual([]);
    });

    test("non-array JSON object returns []", () => {
        expect(parsePrListOutput('{"a":1}')).toEqual([]);
    });

    test("non-array JSON number returns []", () => {
        expect(parsePrListOutput("5")).toEqual([]);
    });

    test("non-array JSON string literal returns []", () => {
        expect(parsePrListOutput('"hello"')).toEqual([]);
    });

    test("non-array JSON null returns []", () => {
        expect(parsePrListOutput("null")).toEqual([]);
    });

    test("invalid JSON returns []", () => {
        expect(parsePrListOutput("not json")).toEqual([]);
    });

    test("empty string returns []", () => {
        expect(parsePrListOutput("")).toEqual([]);
    });

    test("truncated JSON returns []", () => {
        expect(parsePrListOutput("[{")).toEqual([]);
    });
});

describe("fetchPullRequests", () => {
    test("resolves to [] for a nonexistent cwd (gh will fail)", async () => {
        const result = await Effect.runPromise(
            fetchPullRequests({ cwd: "/nonexistent-xyz-12345", limit: 5 }),
        );
        expect(result).toEqual([]);
    });
});
