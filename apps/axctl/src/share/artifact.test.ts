import { describe, expect, it } from "bun:test";
import {
    AX_SESSION_SHARE_SCHEMA_VERSION,
    isAxSessionShare,
    minimalShareArtifact,
} from "./artifact.ts";

describe("share artifact", () => {
    it("recognizes the minimal V1 artifact", () => {
        const artifact = minimalShareArtifact({
            id: "abc123",
            source: "codex",
        });

        expect(artifact.schema_version).toBe(AX_SESSION_SHARE_SCHEMA_VERSION);
        expect(artifact.exported_at).toBe("2026-05-29T00:00:00.000Z");
        expect(artifact.ax_version).toBe("0.0.0-test");
        expect(artifact.stats).toEqual({
            turns: 0,
            tool_calls: 0,
            files_changed: 0,
            skills_used: 0,
            failures: 0,
        });
        expect(artifact.timeline).toEqual([]);
        expect(artifact.files).toEqual([]);
        expect(artifact.graph).toEqual({
            nodes: [],
            edges: [],
        });
        expect(artifact.derived).toEqual({});
        expect(artifact.redactions).toEqual({
            applied: false,
            rules: [],
        });
        expect(isAxSessionShare(artifact)).toBe(true);
    });

    it("rejects unsupported schema versions", () => {
        const artifact = minimalShareArtifact({
            id: "abc123",
            source: "codex",
        });

        expect(isAxSessionShare({ ...artifact, schema_version: 999 })).toBe(false);
    });

    it("rejects artifacts missing derived data", () => {
        const artifact = minimalShareArtifact({
            id: "abc123",
            source: "codex",
        });
        const { derived: _derived, ...withoutDerived } = artifact;

        expect(isAxSessionShare(withoutDerived)).toBe(false);
    });

    it("rejects artifacts missing redactions", () => {
        const artifact = minimalShareArtifact({
            id: "abc123",
            source: "codex",
        });
        const { redactions: _redactions, ...withoutRedactions } = artifact;

        expect(isAxSessionShare(withoutRedactions)).toBe(false);
    });

    it("rejects artifacts with invalid redaction rules", () => {
        const artifact = minimalShareArtifact({
            id: "abc123",
            source: "codex",
        });

        expect(isAxSessionShare({
            ...artifact,
            redactions: {
                applied: false,
                rules: "not-an-array",
            },
        })).toBe(false);
    });
});
