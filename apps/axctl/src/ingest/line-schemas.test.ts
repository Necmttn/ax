import { describe, expect, it } from "bun:test";
import {
    decodeClaudeTranscriptLine,
    decodeCodexTranscriptLine,
    decodePiTranscriptLine,
} from "./line-schemas.ts";

describe("decodeClaudeTranscriptLine", () => {
    it("decodes a well-formed assistant line head", () => {
        const decoded = decodeClaudeTranscriptLine({
            type: "assistant",
            timestamp: "2026-06-01T00:00:00.000Z",
            cwd: "/repo",
            uuid: "u-1",
            message: {
                model: "claude-opus-4",
                content: [{ type: "text", text: "hi" }],
                usage: {
                    input_tokens: 10,
                    output_tokens: 5,
                    cache_creation_input_tokens: 1,
                    cache_read_input_tokens: 2,
                },
            },
        });
        expect(decoded).not.toBeNull();
        expect(decoded?.type).toBe("assistant");
        expect(decoded?.timestamp).toBe("2026-06-01T00:00:00.000Z");
        expect(decoded?.cwd).toBe("/repo");
        expect(decoded?.uuid).toBe("u-1");
        expect(decoded?.message?.model).toBe("claude-opus-4");
        expect(decoded?.message?.usage?.input_tokens).toBe(10);
        expect(decoded?.message?.usage?.cache_read_input_tokens).toBe(2);
        expect(Array.isArray(decoded?.message?.content)).toBe(true);
    });

    it("is tolerant: wrong-typed fields decode to undefined, not failure", () => {
        const decoded = decodeClaudeTranscriptLine({
            type: 3,
            timestamp: 1736000000,
            cwd: { nested: true },
            isCompactSummary: "true",
            message: {
                model: 42,
                usage: { input_tokens: "10", output_tokens: 5 },
            },
        });
        expect(decoded).not.toBeNull();
        expect(decoded?.type).toBeUndefined();
        expect(decoded?.timestamp).toBeUndefined();
        expect(decoded?.cwd).toBeUndefined();
        expect(decoded?.isCompactSummary).toBeUndefined();
        expect(decoded?.message?.model).toBeUndefined();
        expect(decoded?.message?.usage?.input_tokens).toBeUndefined();
        expect(decoded?.message?.usage?.output_tokens).toBe(5);
    });

    it("tolerates non-record usage / message (mirrors isRecord probes)", () => {
        const withBadUsage = decodeClaudeTranscriptLine({
            type: "assistant",
            message: { usage: 7 },
        });
        expect(withBadUsage?.message?.usage).toBeUndefined();

        const withBadMessage = decodeClaudeTranscriptLine({
            type: "assistant",
            message: "not-a-record",
        });
        expect(withBadMessage?.message).toBeUndefined();
    });

    it("returns null for non-record input", () => {
        expect(decodeClaudeTranscriptLine("nope")).toBeNull();
        expect(decodeClaudeTranscriptLine(null)).toBeNull();
        expect(decodeClaudeTranscriptLine([1, 2])).toBeNull();
    });

    it("an empty record decodes with every field undefined", () => {
        const decoded = decodeClaudeTranscriptLine({});
        expect(decoded).not.toBeNull();
        expect(decoded?.type).toBeUndefined();
        expect(decoded?.message).toBeUndefined();
    });
});

describe("decodeCodexTranscriptLine", () => {
    it("decodes type + timestamp and tolerates junk", () => {
        const decoded = decodeCodexTranscriptLine({
            type: "response_item",
            timestamp: "2026-06-01T00:00:00.000Z",
            payload: { anything: true },
        });
        expect(decoded?.type).toBe("response_item");
        expect(decoded?.timestamp).toBe("2026-06-01T00:00:00.000Z");

        const junk = decodeCodexTranscriptLine({ type: 1, timestamp: null });
        expect(junk).not.toBeNull();
        expect(junk?.type).toBeUndefined();
        expect(junk?.timestamp).toBeUndefined();
    });

    it("returns null for non-record input", () => {
        expect(decodeCodexTranscriptLine(42)).toBeNull();
    });
});

describe("decodePiTranscriptLine", () => {
    it("decodes the session head fields", () => {
        const decoded = decodePiTranscriptLine({
            type: "session",
            id: "pi-1",
            timestamp: "2026-06-01T00:00:00.000Z",
            cwd: "/repo",
            version: 3,
        });
        expect(decoded?.type).toBe("session");
        expect(decoded?.id).toBe("pi-1");
        expect(decoded?.version).toBe(3);
    });

    it("tolerates wrong-typed head fields", () => {
        const decoded = decodePiTranscriptLine({
            type: "session",
            id: 9,
            version: "3",
            parentId: {},
        });
        expect(decoded?.type).toBe("session");
        expect(decoded?.id).toBeUndefined();
        expect(decoded?.version).toBeUndefined();
        expect(decoded?.parentId).toBeUndefined();
    });

    it("returns null for non-record input", () => {
        expect(decodePiTranscriptLine([])).toBeNull();
    });
});
