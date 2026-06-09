import { describe, expect, it, test } from "bun:test";
import {
    attachStructuredToolCalls,
    buildShareArtifactFromParts,
    normalizeSessionRecordRef,
} from "./exporter.ts";
import type { ShareTurn } from "./artifact.ts";

const turn = (seq: number, text: string): ShareTurn => ({ id: `t${seq}`, seq, role: "assistant", text });

describe("attachStructuredToolCalls", () => {
    test("attaches typed tool_calls to the matching empty-text turn", () => {
        const turns = [turn(0, "")];
        const calls = [{ seq: 0, name: "WebFetch", input_json: "{\"url\":\"https://paxel.ai\"}", command: null, output: "ok", has_error: false }];
        const [out] = attachStructuredToolCalls(turns, calls);
        expect(out!.tool_calls?.length).toBe(1);
        const c = out!.tool_calls![0]!;
        expect(c.name).toBe("WebFetch");
        expect(c.category).toBe("net");
        expect(c.input).toEqual({ url: "https://paxel.ai" });
        expect(c.output_excerpt).toBe("ok");
        expect(out!.text).toBe(""); // no baked 🔧 text
    });

    test("Bash-style call carries command, null input", () => {
        const calls = [{ seq: 0, name: "Bash", input_json: null, command: "git status", output: null, has_error: false }];
        const [out] = attachStructuredToolCalls([turn(0, "")], calls);
        const c = out!.tool_calls![0]!;
        expect(c.command).toBe("git status");
        expect(c.category).toBe("sh");
    });

    test("invalid input_json leaves input null", () => {
        const calls = [{ seq: 0, name: "Bash", input_json: "not json", command: null, output: null, has_error: false }];
        const [out] = attachStructuredToolCalls([turn(0, "")], calls);
        expect(out!.tool_calls![0]!.input).toBeNull();
    });

    test("array input_json is rejected (non-object) → input null", () => {
        const calls = [{ seq: 0, name: "Bash", input_json: "[1,2,3]", command: null, output: null, has_error: false }];
        const [out] = attachStructuredToolCalls([turn(0, "")], calls);
        expect(out!.tool_calls![0]!.input).toBeNull();
    });

    test("sets has_tool_use and carries the full stored output_excerpt (no re-truncation)", () => {
        // The DB already bounds output_excerpt at ingest; the exporter must not
        // re-truncate - full output is the locked share contract.
        const calls = [{ seq: 0, name: "Bash", input_json: null, command: "x", output: "z".repeat(1000), has_error: false }];
        const [out] = attachStructuredToolCalls([turn(0, "")], calls);
        expect(out!.has_tool_use).toBe(true);
        expect(out!.tool_calls![0]!.output_excerpt!.length).toBe(1000);
    });
});
import { minimalShareArtifact } from "./artifact.ts";

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
            tokenUsage: {
                model: "gpt-5",
                prompt_tokens: 100,
                completion_tokens: 20,
                cache_creation_input_tokens: 30,
                cache_read_input_tokens: 40,
                estimated_tokens: 190,
                estimated_input_cost_usd: 0.01,
                estimated_output_cost_usd: 0.02,
                estimated_cache_creation_cost_usd: 0.003,
                estimated_cache_read_cost_usd: 0.001,
                estimated_cost_usd: 0.034,
                pricing_source: "test",
            },
            turns: [
                {
                    id: "turn:abc-0",
                    seq: 0,
                    role: "user",
                    message_kind: "task",
                    text: "Build the readable share view.",
                    content: {
                        document_id: "content_document:abc",
                        parser_id: "claude-jsonl",
                        parser_version: "1",
                        blockset_hash: "hash-1",
                        blocks: [{
                            seq: 0,
                            parent_seq: null,
                            kind: "text",
                            role: "user",
                            heading: null,
                            text: "Build the readable share view.",
                            text_excerpt: "Build the readable share view.",
                            start_offset: 0,
                            end_offset: 30,
                            confidence: 1,
                            atoms: [],
                        }],
                    },
                },
            ],
            timeline: [{ id: "tool_call:abc", kind: "tool_call", title: "exec_command", actor: "agent" }],
            files: [{ path: "src/share/exporter.ts", role: "edited" }],
        });

        expect(artifact.session.id).toBe("abc123");
        expect(artifact.stats.turns).toBe(1);
        expect(artifact.turns[0]?.text).toBe("Build the readable share view.");
        expect(artifact.turns[0]?.content?.blocks[0]?.text).toBe("Build the readable share view.");
        expect(artifact.stats.tool_calls).toBe(2);
        expect(artifact.stats.skills_used).toBe(1);
        expect(artifact.stats.failures).toBe(1);
        expect(artifact.token_usage?.estimated_cache_read_cost_usd).toBe(0.001);
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

    const baseParts = {
        axVersion: "0.2.0",
        exportedAt: "2026-05-29T00:00:00.000Z",
        overview: {
            id: "parent1",
            project: "ax",
            cwd: "/Users/necmttn/Projects/ax",
            model: "gpt-5",
            source: "codex" as const,
            started_at: "2026-05-29T00:00:00.000Z",
            ended_at: "2026-05-29T00:10:00.000Z",
        },
        topSkills: [],
        toolCalls: [],
        turns: [],
        timeline: [],
        files: [],
    };

    it("emits a current-schema artifact", () => {
        const artifact = buildShareArtifactFromParts(baseParts);
        expect(artifact.schema_version).toBe(4);
    });

    it("carries hook fires when present, omits the field when empty", () => {
        const hook = {
            idx: 0,
            ts: "2026-05-29T00:01:00.000Z",
            event: "pre-edit",
            file_path: "src/a.ts",
            inject: true,
            reason: "high_signal",
            latency_ms: 12,
            injected_titles: ["prior session"],
        };
        expect(buildShareArtifactFromParts({ ...baseParts, hookFires: [hook] }).hook_fires).toHaveLength(1);
        expect(buildShareArtifactFromParts({ ...baseParts, hookFires: [] }).hook_fires).toBeUndefined();
        expect(buildShareArtifactFromParts(baseParts).hook_fires).toBeUndefined();
    });

    it("attaches child subagent shares when provided", () => {
        const child = minimalShareArtifact({ id: "child1", source: "codex" });
        const artifact = buildShareArtifactFromParts({
            ...baseParts,
            children: [child],
        });

        expect(artifact.children).toHaveLength(1);
        expect(artifact.children?.[0]?.session.id).toBe("child1");
    });

    it("omits children when none were spawned", () => {
        const artifact = buildShareArtifactFromParts(baseParts);
        expect(artifact.children).toBeUndefined();

        const empty = buildShareArtifactFromParts({ ...baseParts, children: [] });
        expect(empty.children).toBeUndefined();
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
