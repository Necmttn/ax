import { describe, expect, it, test } from "bun:test";
import {
    SESSION_FILE_EVIDENCE_SQL,
    SESSION_TOP_SKILLS_SQL,
    SESSION_SHARE_FILES_SQL,
    SESSION_SHARE_TIMELINE_SQL,
    SESSION_SHARE_TURNS_SQL,
    SESSION_SHARE_TURN_TOOLCALLS_SQL,
    SESSION_SHARE_HOOK_FIRES_SQL,
    SESSION_SHARE_HARNESS_HOOKS_SQL,
    mapSessionShareFileRow,
    mapSessionShareTimelineRow,
    mapSessionShareTurnRow,
} from "./session-detail.ts";

describe("session detail queries", () => {
    test("top skills use denormalized invoked session field", () => {
        expect(SESSION_TOP_SKILLS_SQL).toContain("FROM invoked");
        expect(SESSION_TOP_SKILLS_SQL).toContain("WHERE session = $sessionId");
        expect(SESSION_TOP_SKILLS_SQL).not.toContain("WHERE in.session = $sessionId");
    });

    test("file evidence reads shared relation tables without provider branches", () => {
        expect(SESSION_FILE_EVIDENCE_SQL).toContain("FROM edited");
        expect(SESSION_FILE_EVIDENCE_SQL).toContain("FROM read_file");
        expect(SESSION_FILE_EVIDENCE_SQL).toContain("FROM searched_file");
        expect(SESSION_FILE_EVIDENCE_SQL).toContain("WHERE in.session = $sessionId");
        expect(SESSION_FILE_EVIDENCE_SQL).not.toContain("provider =");
        expect(SESSION_FILE_EVIDENCE_SQL).not.toContain("source = \"claude\"");
        expect(SESSION_FILE_EVIDENCE_SQL).not.toContain("source = \"codex\"");
        expect(SESSION_FILE_EVIDENCE_SQL).not.toContain("source = \"pi\"");
    });
});

describe("session share query mappers", () => {
    it("maps turn rows into readable share turns", () => {
        const mapped = mapSessionShareTurnRow({
            id: "turn:abc-0",
            seq: 0,
            ts: "2026-05-29T00:00:00.000Z",
            role: "user",
            message_kind: "task",
            intent_kind: "organic_task",
            text: "Build the readable share view.",
            text_excerpt: "Build the readable share view.",
            has_tool_use: false,
            has_error: false,
        });

        expect(mapped).toEqual({
            id: "turn:abc-0",
            seq: 0,
            ts: "2026-05-29T00:00:00.000Z",
            role: "user",
            message_kind: "task",
            intent_kind: "organic_task",
            text: "Build the readable share view.",
            text_excerpt: "Build the readable share view.",
            has_tool_use: false,
            has_error: false,
        });
    });

    it("maps tool call rows into share timeline rows", () => {
        const mapped = mapSessionShareTimelineRow({
            id: "tool_call:abc",
            ts: "2026-05-29T00:00:00.000Z",
            kind: "tool_call",
            title: "exec_command",
            summary: "bun test",
        });

        expect(mapped).toEqual({
            id: "tool_call:abc",
            ts: "2026-05-29T00:00:00.000Z",
            kind: "tool_call",
            actor: "agent",
            title: "exec_command",
            summary: "bun test",
        });
    });

    it("maps edited file rows into share files", () => {
        const mapped = mapSessionShareFileRow({
            path: "src/share/exporter.ts",
            role: "edited",
            lang: "ts",
            additions: 12,
            deletions: 3,
        });

        expect(mapped).toEqual({
            path: "src/share/exporter.ts",
            role: "edited",
            lang: "ts",
            additions: 12,
            deletions: 3,
        });
    });

    it("drops timeline rows without required fields", () => {
        expect(mapSessionShareTimelineRow({
            id: "tool_call:abc",
            title: "",
        })).toBeNull();
        expect(mapSessionShareTimelineRow({
            title: "exec_command",
        })).toBeNull();
    });

    it("drops file rows without a path", () => {
        expect(mapSessionShareFileRow({ role: "edited" })).toBeNull();
    });

    it("keeps share queries session scoped and bounded", () => {
        expect(SESSION_SHARE_TIMELINE_SQL).toContain("WHERE session = $sessionId");
        expect(SESSION_SHARE_TIMELINE_SQL).toContain("LIMIT 200");
        expect(SESSION_SHARE_TURNS_SQL).toContain("WHERE session = $sessionId");
        expect(SESSION_SHARE_TURNS_SQL).toContain("LIMIT 2000");
        expect(SESSION_SHARE_TURN_TOOLCALLS_SQL).toContain("WHERE session = $sessionId");
        expect(SESSION_SHARE_TURN_TOOLCALLS_SQL).toContain("LIMIT 4000");
        expect(SESSION_SHARE_HOOK_FIRES_SQL).toContain("WHERE session = $sessionId");
        expect(SESSION_SHARE_HOOK_FIRES_SQL).toContain("LIMIT 2000");
        expect(SESSION_SHARE_HARNESS_HOOKS_SQL).toContain("WHERE session = $sessionId");
        expect(SESSION_SHARE_HARNESS_HOOKS_SQL).toContain("LIMIT 2000");
        expect(SESSION_SHARE_FILES_SQL).toContain("WHERE in.session = $sessionId");
        expect(SESSION_SHARE_FILES_SQL).toContain("LIMIT 200");
    });

    it("selects the timestamp used to order share file rows", () => {
        expect(SESSION_SHARE_FILES_SQL).toMatch(/\bSELECT\s+ts,/);
        expect(SESSION_SHARE_FILES_SQL).toContain("ORDER BY ts ASC");
    });
});
