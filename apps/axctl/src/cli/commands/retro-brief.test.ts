import { describe, expect, it } from "bun:test";
import { formatRetroBrief } from "./retro.ts";

describe("formatRetroBrief", () => {
    it("makes the normalized Turn view authoritative and keeps raw JSONL secondary", () => {
        const brief = formatRetroBrief(
            {
                sessionId: "session:pi-session-123",
                key: "pi-session-123",
                project: "-Users-example-Projects-ax",
                source: "pi",
                model: "claude-sonnet-4",
                startedAt: "2026-07-15T01:00:00Z",
                endedAt: "2026-07-15T01:10:00Z",
                lastTurnAt: null,
                turns: 18,
                reason: "ended_at",
            },
            "/Users/example/.pi/agent/sessions/pi-session-123.jsonl",
            "sonnet",
        );

        expect(brief).toContain(
            "`ax sessions show session:pi-session-123 --turns --json`",
        );
        expect(brief).toContain(
            "raw transcript (harness-specific, large): `/Users/example/.pi/agent/sessions/pi-session-123.jsonl`",
        );
        expect(brief).not.toContain("Source of truth is the\ntranscript at");
    });

    it("teaches the reviewer to prefer normalized turns over raw harness JSONL", async () => {
        const template = await Bun.file(
            new URL("../../../../../agents/retro-reviewer.md", import.meta.url),
        ).text();

        expect(template).toContain(
            "ax sessions show <session_id> --turns --json",
        );
        expect(template).toContain("raw transcript as a secondary fallback");
        expect(template).not.toContain('failed: "transcript missing"');
        expect(template).toContain("normalized Turn view and raw fallback are both unavailable");
    });

    it("documents an inline fallback when the reviewer subagent is unavailable", async () => {
        const skill = await Bun.file(
            new URL("../../../../../skills/retro/SKILL.md", import.meta.url),
        ).text();

        expect(skill).toContain("doesn't resolve");
        expect(skill).toContain("review the brief INLINE");
    });
});
