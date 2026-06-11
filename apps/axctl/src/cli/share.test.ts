import { describe, expect, it } from "bun:test";
import { minimalShareArtifact, type AxSessionShare } from "../share/artifact.ts";
import { formatStaleUsageWarning } from "../share/format.ts";
import type { ShareTranscriptHit } from "../share/recover.ts";
import { cmdShareWithDeps, parseShareArgs, type ShareCommandDeps } from "./share.ts";

const SESSION_USAGE = {
    model: "claude-opus-4-5",
    prompt_tokens: null,
    completion_tokens: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    estimated_tokens: 5000,
    estimated_cost_usd: 0.05,
    pricing_source: "test",
};

const TURN_USAGE = {
    ...SESSION_USAGE,
    seq: 1,
    fresh_input_tokens: null,
    usage_source: "api",
    usage_quality: "exact",
};

function makeHarness(
    artifact: AxSessionShare | null = minimalShareArtifact({ id: "abc123", source: "codex" }),
    overrides: Partial<ShareCommandDeps> = {},
) {
    let stdout = "";
    let stderr = "";
    let exitCode: number | undefined;
    const published: Parameters<ShareCommandDeps["publish"]>[0][] = [];
    const locateCalls: string[] = [];
    const ingestCalls: ShareTranscriptHit[] = [];
    const deps: ShareCommandDeps = {
        exportArtifact: async () => artifact,
        locateTranscript: async (sessionId) => {
            locateCalls.push(sessionId);
            return null;
        },
        ingestSession: async (hit) => {
            ingestCalls.push(hit);
            return { kind: "ingested" };
        },
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
        ...overrides,
    };

    return {
        deps,
        published,
        locateCalls,
        ingestCalls,
        exitCode: () => exitCode,
        setStaleExitCode: (code: number) => {
            exitCode = code;
        },
        stdout: () => stdout,
        stderr: () => stderr,
    };
}

const CLAUDE_HIT: ShareTranscriptHit = {
    path: "/home/u/.claude/projects/-Users-u-Projects-ax/abc123.jsonl",
    harness: "claude",
};

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

    it("sets exitCode 1 when the session is missing and no transcript exists on disk", async () => {
        const harness = makeHarness(null);
        await cmdShareWithDeps(["missing123"], harness.deps);

        expect(harness.exitCode()).toBe(1);
        expect(harness.stderr()).toContain("axctl share: session missing123 not found");
        expect(harness.locateCalls).toEqual(["missing123"]);
        expect(harness.ingestCalls).toHaveLength(0);
        expect(harness.published).toHaveLength(0);
    });

    it("does not touch the disk fallback when the export succeeds first try", async () => {
        const harness = makeHarness();
        await cmdShareWithDeps(["abc123", "--dry-run"], harness.deps);

        expect(harness.locateCalls).toHaveLength(0);
        expect(harness.ingestCalls).toHaveLength(0);
    });

    it("ingests the on-disk transcript and retries the export on a graph miss", async () => {
        const artifact = minimalShareArtifact({ id: "abc123", source: "claude" });
        const exports: Array<AxSessionShare | null> = [null, artifact];
        const harness = makeHarness(null, {
            exportArtifact: async () => exports.shift() ?? null,
            locateTranscript: async () => CLAUDE_HIT,
        });
        await cmdShareWithDeps(["abc123", "--dry-run"], harness.deps);

        expect(harness.stderr()).toContain(
            "axctl share: session abc123 not in graph - ingesting it now…",
        );
        expect(harness.ingestCalls).toEqual([CLAUDE_HIT]);
        expect(harness.exitCode()).toBeUndefined();
        // --dry-run semantics intact after the recovery: bundle on stdout, no publish.
        const bundle = JSON.parse(harness.stdout());
        expect(bundle["index.json"].session.id).toBe("abc123");
        expect(harness.published).toHaveLength(0);
    });

    it("publishes after a successful miss->ingest->retry with --yes", async () => {
        const artifact = minimalShareArtifact({ id: "abc123", source: "claude" });
        const exports: Array<AxSessionShare | null> = [null, artifact];
        const harness = makeHarness(null, {
            exportArtifact: async () => exports.shift() ?? null,
            locateTranscript: async () => CLAUDE_HIT,
        });
        await cmdShareWithDeps(["abc123", "--yes"], harness.deps);

        expect(harness.exitCode()).toBeUndefined();
        expect(harness.published).toHaveLength(1);
        expect(harness.stdout()).toContain("https://ax.necmttn.com/s/necmttn/gist123");
    });

    it("reports a busy ingest lock instead of deadlocking", async () => {
        const harness = makeHarness(null, {
            locateTranscript: async () => CLAUDE_HIT,
            ingestSession: async () => ({ kind: "busy", pid: 4242, command: "ingest" }),
        });
        await cmdShareWithDeps(["abc123"], harness.deps);

        expect(harness.exitCode()).toBe(1);
        expect(harness.stderr()).toContain(
            "another ingest (pid 4242, ingest) is in progress",
        );
        expect(harness.published).toHaveLength(0);
    });

    it("reports a failed targeted ingest with what was attempted", async () => {
        const harness = makeHarness(null, {
            locateTranscript: async () => CLAUDE_HIT,
            ingestSession: async () => ({ kind: "failed", message: "db exploded" }),
        });
        await cmdShareWithDeps(["abc123"], harness.deps);

        expect(harness.exitCode()).toBe(1);
        expect(harness.stderr()).toContain(
            `targeted ingest of ${CLAUDE_HIT.path} failed: db exploded`,
        );
        expect(harness.published).toHaveLength(0);
    });

    it("fails with what was attempted when the session is still missing after ingest", async () => {
        const harness = makeHarness(null, {
            locateTranscript: async () => CLAUDE_HIT,
        });
        await cmdShareWithDeps(["abc123"], harness.deps);

        expect(harness.ingestCalls).toEqual([CLAUDE_HIT]);
        expect(harness.exitCode()).toBe(1);
        expect(harness.stderr()).toContain(
            `ingested ${CLAUDE_HIT.path}, but the session still did not appear in the graph`,
        );
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
            token_usage: SESSION_USAGE,
            turns: [
                { id: "t1", seq: 1, role: "user", text: "hello" },
            ],
        };
        const harness = makeHarness(artifact);
        await cmdShareWithDeps(["abc123", "--dry-run"], harness.deps);

        expect(harness.stderr()).toBe(formatStaleUsageWarning());
        expect(formatStaleUsageWarning()).toBe(
            "axctl share: warning: this share has session-level cost but no per-turn usage rows; cost rails may render as $0.\n" +
            "Re-run ingest with AX_REDERIVE_CLAUDE=1 AX_REDERIVE_SUBAGENTS=1 ax ingest here --stages=claude,subagents --since=N\n",
        );
    });

    it("does not emit stale-usage warning when turns have token_usage", async () => {
        const artifact: AxSessionShare = {
            ...minimalShareArtifact({ id: "abc123", source: "claude" }),
            token_usage: SESSION_USAGE,
            turns: [
                {
                    id: "t1",
                    seq: 1,
                    role: "assistant",
                    text: "hello",
                    token_usage: TURN_USAGE,
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
