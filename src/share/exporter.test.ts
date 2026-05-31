import { describe, expect, it } from "bun:test";
import {
    buildShareArtifactFromParts,
    normalizeSessionRecordRef,
} from "./exporter.ts";

describe("buildShareArtifactFromParts", () => {
    it("builds a V1 artifact from session rows", () => {
        const artifact = buildShareArtifactFromParts({
            axVersion: "0.2.0",
            exportedAt: "2026-05-29T00:00:00.000Z",
            overview: {
                id: "abc123",
                project: "ax",
                cwd: "/Users/necmttn/Projects/ax",
                model: "gpt-5",
                source: "codex",
                started_at: "2026-05-29T00:00:00.000Z",
                ended_at: "2026-05-29T00:10:00.000Z",
            },
            topSkills: [{ skill: "superpowers:writing-plans", count: 1, last_used: "2026-05-29T00:01:00.000Z" }],
            toolCalls: [{ label: "exec_command", count: 2, failures: 1, last_used: "2026-05-29T00:02:00.000Z" }],
            turns: [
                {
                    id: "turn:abc-0",
                    seq: 0,
                    role: "user",
                    message_kind: "task",
                    text: "Build the readable share view.",
                },
            ],
            timeline: [{ id: "tool_call:abc", kind: "tool_call", title: "exec_command", actor: "agent" }],
            files: [{ path: "src/share/exporter.ts", role: "edited" }],
        });

        expect(artifact.session.id).toBe("abc123");
        expect(artifact.stats.turns).toBe(1);
        expect(artifact.turns[0]?.text).toBe("Build the readable share view.");
        expect(artifact.stats.tool_calls).toBe(2);
        expect(artifact.stats.skills_used).toBe(1);
        expect(artifact.stats.failures).toBe(1);
        expect(artifact.files).toHaveLength(1);
        expect(artifact.graph.nodes.some((n) => n.id === "session:abc123")).toBe(true);
    });

    it("dedupes repeated file paths and preserves the first file metadata", () => {
        const artifact = buildShareArtifactFromParts({
            axVersion: "0.2.0",
            exportedAt: "2026-05-29T00:00:00.000Z",
            overview: {
                id: "abc123",
                project: "ax",
                cwd: "/Users/necmttn/Projects/ax",
                model: "gpt-5",
                source: "codex",
                started_at: "2026-05-29T00:00:00.000Z",
                ended_at: "2026-05-29T00:10:00.000Z",
            },
            topSkills: [],
            toolCalls: [],
            turns: [],
            timeline: [],
            files: [
                { path: "src/a.ts", lang: "ts", role: "edited", additions: 1 },
                { path: "src/a.ts", lang: "tsx", role: "touched", additions: 99 },
                { path: "src/b.ts", lang: "ts", role: "edited", additions: 2 },
            ],
        });

        const fileNodes = artifact.graph.nodes.filter((n) => n.kind === "file");
        const fileEdges = artifact.graph.edges.filter((e) => e.label === "changed");

        expect(artifact.files).toEqual([
            { path: "src/a.ts", lang: "ts", role: "edited", additions: 1 },
            { path: "src/b.ts", lang: "ts", role: "edited", additions: 2 },
        ]);
        expect(artifact.stats.files_changed).toBe(2);
        expect(fileNodes.map((n) => n.id)).toEqual(["file:src/a.ts", "file:src/b.ts"]);
        expect(fileEdges).toEqual([
            { from: "session:abc123", to: "file:src/a.ts", label: "changed" },
            { from: "session:abc123", to: "file:src/b.ts", label: "changed" },
        ]);
    });
});

describe("normalizeSessionRecordRef", () => {
    it("normalizes accepted session id forms to bracketed record refs", () => {
        expect(normalizeSessionRecordRef("abc123")).toBe("session:⟨abc123⟩");
        expect(normalizeSessionRecordRef("session:abc123")).toBe("session:⟨abc123⟩");
        expect(normalizeSessionRecordRef("session:⟨abc123⟩")).toBe("session:⟨abc123⟩");
    });

    it("rejects invalid session ids", () => {
        expect(normalizeSessionRecordRef("abc12")).toBeNull();
        expect(normalizeSessionRecordRef("abc123;DELETE session")).toBeNull();
        expect(normalizeSessionRecordRef("session:⟨abc123")).toBeNull();
    });
});
