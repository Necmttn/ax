import { describe, expect, test } from "bun:test";
import {
    buildReactionEventStatements,
    deriveReactionEvents,
    type ReactionEventInput,
} from "./reaction-events.ts";

const row = (overrides: Partial<ReactionEventInput> & Pick<ReactionEventInput, "id" | "session" | "seq" | "role" | "text">): ReactionEventInput => {
    const base: ReactionEventInput = {
        id: overrides.id,
        session: overrides.session,
        seq: overrides.seq,
        role: overrides.role,
        text: overrides.text ?? null,
        message_kind: null,
        intent_kind: null,
        text_excerpt: overrides.text ?? null,
        ts: new Date(`2026-05-30T00:0${overrides.seq}:00Z`),
    };
    return { ...base, ...overrides };
};

describe("reaction event classifier", () => {
    test("uses prior assistant and tool failure context to classify uv as environment direction", () => {
        const events = deriveReactionEvents([
            row({
                id: "turn:a1",
                session: "session:s1",
                seq: 1,
                role: "assistant",
                text: "I am setting up Python packages with pip for the classifier prototype.",
            }),
            row({
                id: "turn:t1",
                session: "session:s1",
                seq: 2,
                role: "tool_result",
                message_kind: "tool_result",
                text: "ERROR: dependency resolution failed while installing sklearn packages",
            }),
            row({
                id: "turn:u1",
                session: "session:s1",
                seq: 3,
                role: "user",
                text: "can you use UV ?",
            }),
        ]);

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            userTurnKey: "u1",
            assistantTurnKey: "a1",
            reactionType: "direction",
            target: "environment_setup",
            polarity: "revise",
            durability: "repo_preference",
        });
        expect(events[0].signals).toEqual(expect.arrayContaining([
            "tooling:uv",
            "context:recent_tool_failure",
            "target:environment_setup",
        ]));
        expect(events[0].context.recentToolFailureText).toContain("dependency resolution failed");
    });

    test("classifies not-just-html feedback as prototype completeness correction", () => {
        const events = deriveReactionEvents([
            row({
                id: "turn:a1",
                session: "session:s1",
                seq: 1,
                role: "assistant",
                text: "I created a static HTML prototype page for you to open.",
            }),
            row({
                id: "turn:u1",
                session: "session:s1",
                seq: 2,
                role: "user",
                text: "i dont want just html i want to see the results. try setting up a classifier and apply to surrealml",
            }),
        ]);

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            reactionType: "correction",
            target: "prototype_completeness",
            polarity: "revise",
            durability: "repo_preference",
        });
        expect(events[0].signals).toEqual(expect.arrayContaining([
            "prototype:not_just_html",
            "target:prototype_completeness",
        ]));
    });

    test("builds schemafull upserts with context json and stable ids", () => {
        const [event] = deriveReactionEvents([
            row({
                id: "turn:a1",
                session: "session:s1",
                seq: 1,
                role: "assistant",
                text: "I will use npm for this.",
            }),
            row({
                id: "turn:u1",
                session: "session:s1",
                seq: 2,
                role: "user",
                text: "use bun instead",
            }),
        ]);

        const sql = buildReactionEventStatements([event]).join("\n");
        // id is keyed by user_turn alone (stable + idempotent vs the unique index)
        expect(sql).toContain("UPSERT reaction_event:`u1`");
        expect(sql).toContain('reaction_type: "direction"');
        expect(sql).toContain('target: "environment_setup"');
        expect(sql).toContain("context_json");
        expect(sql).toContain("assistant_turn");
    });
});
