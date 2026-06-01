import { homedir } from "node:os";
import { describe, expect, it } from "bun:test";
import { redactShareText, redactShareArtifact } from "./redact.ts";
import { minimalShareArtifact } from "./artifact.ts";

describe("share redaction", () => {
    it("redacts common secrets and home paths", () => {
        const projectPath = `${homedir()}/Projects/ax`;
        const result = redactShareText(
            `OPENAI_API_KEY=sk-test123 ${projectPath} Authorization: Bearer abc.def`,
        );

        expect(result.text).toContain("[REDACTED_SECRET]");
        expect(result.text).toContain("~/Projects/ax");
        expect(result.rules).toContain("openai-api-key");
        expect(result.rules).toContain("home-path");
        expect(result.rules).toContain("authorization-bearer");
    });

    it("redacts env secret assignments when the sensitive word starts the key", () => {
        const result = redactShareText("PASSWORD=secret TOKEN=abc SECRET=value API_KEY=xyz");

        expect(result.text).toBe(
            "PASSWORD=[REDACTED_SECRET] TOKEN=[REDACTED_SECRET] SECRET=[REDACTED_SECRET] API_KEY=[REDACTED_SECRET]",
        );
        expect(result.rules).toContain("env-secret-assignment");
    });

    it("redacts quoted env secret values", () => {
        const result = redactShareText("PASSWORD=\"hunter2\" TOKEN='abc'");

        expect(result.text).not.toContain("hunter2");
        expect(result.text).not.toContain("abc");
        expect(result.text).toContain("[REDACTED_SECRET]");
        expect(result.rules).toContain("env-secret-assignment");
    });

    it("redacts common standalone service tokens", () => {
        const result = redactShareText([
            "github_pat_11ABCDEFG0123456789abcdefghijklmnopqrstuvwxyz0123456789",
            "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
            "xoxb-fake-123456789012-123456789012-abcdefghijklmnopqrstuvwx",
            "AKIAIOSFODNN7EXAMPLE",
        ].join(" "));

        expect(result.text).not.toContain("github_pat_11ABCDEFG");
        expect(result.text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
        expect(result.text).not.toContain("xoxb-fake-123456789012");
        expect(result.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
        expect(result.text.match(/\[REDACTED_SECRET\]/g)).toHaveLength(4);
        expect(result.rules).toContain("github-token");
        expect(result.rules).toContain("slack-token");
        expect(result.rules).toContain("aws-access-key-id");
    });

    it("redacts string fields inside share artifacts", () => {
        const artifact = minimalShareArtifact({ id: "abc123", source: "codex" });
        const projectPath = `${homedir()}/Projects/ax`;
        const redacted = redactShareArtifact({
            ...artifact,
            session: {
                ...artifact.session,
                project: projectPath,
                summary: "Authorization: Bearer secret-token",
            },
        });

        expect(redacted.artifact.session.project).toBe("~/Projects/ax");
        expect(redacted.artifact.session.summary).toBe("Authorization: Bearer [REDACTED_SECRET]");
        expect(redacted.artifact.redactions.applied).toBe(true);
        expect(redacted.artifact.redactions.rules).toContain("authorization-bearer");
    });

    it("redacts nested turn content blocks in share artifacts", () => {
        const artifact = minimalShareArtifact({ id: "abc123", source: "codex" });
        const redacted = redactShareArtifact({
            ...artifact,
            turns: [{
                id: "turn:abc-1",
                seq: 1,
                role: "assistant",
                text: "ok",
                content: {
                    document_id: "content_document:abc",
                    parser_id: "codex-jsonl",
                    parser_version: "1",
                    blockset_hash: null,
                    blocks: [{
                        seq: 0,
                        parent_seq: null,
                        kind: "tool_call",
                        role: "assistant",
                        heading: null,
                        text: "Authorization: Bearer secret-token",
                        text_excerpt: "Authorization: Bearer secret-token",
                        start_offset: 0,
                        end_offset: 34,
                        confidence: 1,
                        atoms: [{
                            kind: "command",
                            value: "OPENAI_API_KEY=sk-test123",
                            normalized: null,
                            confidence: 1,
                            raw: null,
                        }],
                    }],
                },
            }],
        });

        expect(redacted.artifact.turns[0]?.content?.blocks[0]?.text).toBe("Authorization: Bearer [REDACTED_SECRET]");
        expect(redacted.artifact.turns[0]?.content?.blocks[0]?.atoms[0]?.value).toBe("OPENAI_API_KEY=[REDACTED_SECRET]");
        expect(redacted.artifact.redactions.rules).toContain("authorization-bearer");
        expect(redacted.artifact.redactions.rules).toContain("openai-api-key");
    });
});
