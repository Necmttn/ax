import { describe, expect, it } from "bun:test";
import { minimalShareArtifact, type AxSessionShare } from "../share/artifact.ts";
import { cmdShareWithDeps, parseShareArgs, type ShareCommandDeps } from "./share.ts";

function makeHarness(
    artifact: AxSessionShare | null = minimalShareArtifact({ id: "abc123", source: "codex" }),
) {
    let stdout = "";
    let stderr = "";
    let exitCode: number | undefined;
    const published: Parameters<ShareCommandDeps["publish"]>[0][] = [];
    const deps: ShareCommandDeps = {
        exportArtifact: async () => artifact,
        publish: async (input) => {
            published.push(input);
            return { owner: "necmttn", gistId: "gist123" };
        },
        open: async () => {},
        writeStdout: (text) => {
            stdout += text;
        },
        writeStderr: (text) => {
            stderr += text;
        },
        setExitCode: (code) => {
            exitCode = code;
        },
        clearExitCode: () => {
            exitCode = undefined;
        },
    };

    return {
        deps,
        published,
        exitCode: () => exitCode,
        setStaleExitCode: (code: number) => {
            exitCode = code;
        },
        stdout: () => stdout,
        stderr: () => stderr,
    };
}

describe("parseShareArgs", () => {
    it("parses dry-run share args", () => {
        expect(parseShareArgs(["abc123", "--dry-run"])).toEqual({
            sessionId: "abc123",
            dryRun: true,
            open: false,
            public: false,
            yes: false,
        });
    });

    it("requires a session id", () => {
        expect(() => parseShareArgs(["--dry-run"])).toThrow("missing <session-id>");
    });

    it("rejects unknown single-dash options", () => {
        expect(() => parseShareArgs(["-x"])).toThrow("unknown option -x");
    });

    it("parses publish flags", () => {
        expect(parseShareArgs(["abc123", "--public", "--open", "--yes"])).toEqual({
            sessionId: "abc123",
            dryRun: false,
            open: true,
            public: true,
            yes: true,
        });
    });
});

describe("cmdShareWithDeps", () => {
    it("writes dry-run JSON and does not publish", async () => {
        const harness = makeHarness();
        await cmdShareWithDeps(["abc123", "--dry-run"], harness.deps);

        expect(harness.exitCode()).toBeUndefined();
        // Dry-run emits the multi-file bundle keyed by gist filename.
        const bundle = JSON.parse(harness.stdout());
        expect(bundle["index.json"].kind).toBe("manifest");
        expect(bundle["index.json"].session.id).toBe("abc123");
        expect(bundle["session.json"].session.id).toBe("abc123");
        expect(harness.stderr()).toBe("");
        expect(harness.published).toHaveLength(0);
    });

    it("shows preview without publishing when --yes is omitted", async () => {
        const harness = makeHarness();
        await cmdShareWithDeps(["abc123"], harness.deps);

        expect(harness.exitCode()).toBe(2);
        expect(harness.stderr()).toContain("Session abc123");
        expect(harness.stderr()).toContain("Re-run with --yes to publish this secret/unlisted Gist.");
        expect(harness.published).toHaveLength(0);
    });

    it("sets exitCode 1 when the session is missing", async () => {
        const harness = makeHarness(null);
        await cmdShareWithDeps(["missing123"], harness.deps);

        expect(harness.exitCode()).toBe(1);
        expect(harness.stderr()).toContain("axctl share: session missing123 not found");
        expect(harness.published).toHaveLength(0);
    });

    it("publishes and prints the share URL with --yes", async () => {
        const harness = makeHarness();
        await cmdShareWithDeps(["abc123", "--yes"], harness.deps);

        expect(harness.exitCode()).toBeUndefined();
        expect(harness.published).toHaveLength(1);
        expect(harness.stdout()).toContain("https://ax.necmttn.com/s/necmttn/gist123");
    });

    it("clears a stale nonzero exitCode on success", async () => {
        const harness = makeHarness();
        harness.setStaleExitCode(2);

        await cmdShareWithDeps(["abc123", "--yes"], harness.deps);

        expect(harness.exitCode()).toBeUndefined();
    });

    it("emits stale-usage warning to stderr when session has cost but no per-turn usage", async () => {
        const artifact: AxSessionShare = {
            ...minimalShareArtifact({ id: "abc123", source: "claude" }),
            token_usage: {
                model: "claude-opus-4-5",
                prompt_tokens: null,
                completion_tokens: null,
                cache_creation_input_tokens: null,
                cache_read_input_tokens: null,
                estimated_tokens: 5000,
                estimated_cost_usd: 0.05,
                pricing_source: "test",
            },
            turns: [
                { id: "t1", seq: 1, role: "user", text: "hello" },
            ],
        };
        const harness = makeHarness(artifact);
        await cmdShareWithDeps(["abc123", "--dry-run"], harness.deps);

        expect(harness.stderr()).toContain("axctl share: warning:");
        expect(harness.stderr()).toContain("session-level cost but no per-turn usage rows");
        expect(harness.stderr()).toContain("AX_REDERIVE_CLAUDE=1");
    });

    it("does not emit stale-usage warning when turns have token_usage", async () => {
        const sessionUsage = {
            model: "claude-opus-4-5",
            prompt_tokens: null,
            completion_tokens: null,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            estimated_tokens: 5000,
            estimated_cost_usd: 0.05,
            pricing_source: "test",
        };
        const artifact: AxSessionShare = {
            ...minimalShareArtifact({ id: "abc123", source: "claude" }),
            token_usage: sessionUsage,
            turns: [
                {
                    id: "t1",
                    seq: 1,
                    role: "assistant",
                    text: "hello",
                    token_usage: {
                        ...sessionUsage,
                        seq: 1,
                        fresh_input_tokens: null,
                        usage_source: "api",
                        usage_quality: "exact",
                    },
                },
            ],
        };
        const harness = makeHarness(artifact);
        await cmdShareWithDeps(["abc123", "--dry-run"], harness.deps);

        expect(harness.stderr()).not.toContain("axctl share: warning:");
    });

    it("does not emit stale-usage warning when there is no session-level usage", async () => {
        const harness = makeHarness();
        await cmdShareWithDeps(["abc123", "--dry-run"], harness.deps);

        expect(harness.stderr()).not.toContain("axctl share: warning:");
    });

    it("passes public visibility into preview and publisher", async () => {
        const harness = makeHarness();
        await cmdShareWithDeps(["abc123", "--public", "--yes"], harness.deps);

        expect(harness.exitCode()).toBeUndefined();
        expect(harness.stderr()).toContain("publish target: public Gist");
        expect(harness.published).toHaveLength(1);
        expect(harness.published[0]?.public).toBe(true);
    });
});
