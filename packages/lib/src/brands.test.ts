import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { SessionId, SkillName } from "./brands.ts";
import { resolveSkillName } from "./skill-id.ts";
import { toBareSessionId } from "./shared/session-id.ts";

describe("SessionId brand", () => {
    it("constructs from a string and stays string-assignable", () => {
        const id = SessionId.make("019e2531-b552-7b53-a029-c780adbb6560");
        const widened: string = id; // branded -> string is free
        expect(widened).toBe("019e2531-b552-7b53-a029-c780adbb6560");
    });

    it("decodes a plain string", () => {
        const decoded = Schema.decodeUnknownSync(SessionId)("claude-subagent-a1f6ef32");
        expect(decoded).toBe(SessionId.make("claude-subagent-a1f6ef32"));
    });

    it("is produced by toBareSessionId (producer-first adoption)", () => {
        const bare: SessionId = toBareSessionId("session:`abc-123`");
        expect(bare).toBe(SessionId.make("abc-123"));
    });
});

describe("SkillName brand", () => {
    it("constructs from a string and stays string-assignable", () => {
        const name = SkillName.make("superpowers:test-driven-development");
        const widened: string = name;
        expect(widened).toBe("superpowers:test-driven-development");
    });

    it("is produced by resolveSkillName (producer-first adoption)", () => {
        const catalog = new Set(["superpowers:subagent-driven-development"]);
        const resolved: SkillName | null = resolveSkillName("subagent-driven-development", catalog);
        expect(resolved).toBe(SkillName.make("superpowers:subagent-driven-development"));
    });
});
