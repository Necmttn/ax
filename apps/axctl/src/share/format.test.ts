import { describe, expect, it } from "bun:test";
import { minimalShareArtifact } from "./artifact.ts";
import { formatSharePreview, formatShareSuccess } from "./format.ts";

describe("share formatter", () => {
    it("prints a concise default private preview", () => {
        const artifact = {
            ...minimalShareArtifact({ id: "abc123", source: "codex" }),
            stats: { turns: 3, tool_calls: 2, files_changed: 1, skills_used: 1, failures: 0 },
        };

        const text = formatSharePreview(artifact);
        expect(text).toContain("Session abc123");
        expect(text).toContain("source: codex");
        expect(text).toContain("turns: 3");
        expect(text).toContain("publish target: secret/unlisted Gist");
    });

    it("prints a public preview when requested", () => {
        const artifact = minimalShareArtifact({ id: "abc123", source: "codex" });

        const text = formatSharePreview(artifact, { public: true });

        expect(text).toContain("publish target: public Gist");
        expect(text).not.toContain("secret/unlisted Gist");
    });

    it("prints the share URL after publishing", () => {
        const text = formatShareSuccess({ owner: "necmttn", gistId: "abc123" });

        expect(text).toContain("Published session share:");
        expect(text).toContain("https://ax.necmttn.com/s/necmttn/abc123");
    });
});
