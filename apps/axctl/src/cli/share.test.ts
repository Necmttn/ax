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
        expect(JSON.parse(harness.stdout()).session.id).toBe("abc123");
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

    it("passes public visibility into preview and publisher", async () => {
        const harness = makeHarness();
        await cmdShareWithDeps(["abc123", "--public", "--yes"], harness.deps);

        expect(harness.exitCode()).toBeUndefined();
        expect(harness.stderr()).toContain("publish target: public Gist");
        expect(harness.published).toHaveLength(1);
        expect(harness.published[0]?.public).toBe(true);
    });
});
