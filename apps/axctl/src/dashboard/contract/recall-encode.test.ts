import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { RecallResponse } from "@ax/lib/shared/api-contract";
import { emptyRecallResponse } from "../recall.ts";

/**
 * HttpApi ENCODES a handler's return through the success schema. RecallResponse
 * is deliberately a Schema.Struct, not a Schema.Class: a class schema's encode
 * demands actual class instances and rejects the plain JS-mapped objects the
 * recall handler returns (decode is lenient, encode is strict). These tests
 * pin that - if someone switches the contract schema back to Schema.Class,
 * the live endpoint 400s and this goes red first.
 */
const encode = Schema.encodeUnknownEffect(Schema.toCodecJson(RecallResponse));

describe("RecallResponse contract schema encodes plain objects", () => {
    test("the empty-q fast-path payload encodes", async () => {
        const value = emptyRecallResponse("", 0, 50);
        const json = await Effect.runPromise(encode(value)) as Record<string, unknown>;
        expect(json).toMatchObject({
            q: "",
            hits: [],
            commits: [],
            skills: [],
            total_counts: { turn: 0, commit: 0, skill: 0 },
            window: { offset: 0, limit: 50 },
        });
    });

    test("a fully-populated payload (all three hit kinds) encodes", async () => {
        const value = {
            q: "x",
            hits: [{
                turn_id: "turn:1", session_id: "s1", project: null, source: "claude",
                cwd: "/p", role: "assistant", ts: "2026-01-01T00:00:00Z", snippet: "hi",
            }],
            commits: [{
                commit_id: "commit:1", sha: "abc", repo: "ax", repository: "repository:r1",
                ts: null, snippet: "msg", score: 1.5,
            }],
            skills: [{ skill_id: "skill:1", name: "tdd", description: null, snippet: "s", score: 2 }],
            truncated: true,
            total_count: 3,
            total_counts: { turn: 1, commit: 1, skill: 1 },
            window: { offset: 0, limit: 50 },
        };
        const back = await Effect.runPromise(encode(value)) as {
            commits: Array<{ score: number }>; skills: Array<{ name: string }>;
        };
        expect(back.commits[0]?.score).toBe(1.5);
        expect(back.skills[0]?.name).toBe("tdd");
    });
});
