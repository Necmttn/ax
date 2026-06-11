import { Effect } from "effect";
import { execFile } from "node:child_process";
import { AppLayer } from "@ax/lib/layers";
import { prettyPrint } from "@ax/lib/json";
import type { AxSessionShare } from "../share/artifact.ts";
import { exportSessionShare } from "../share/exporter.ts";
import { buildShareBundle, type ShareBundle } from "../share/manifest.ts";
import {
    createSessionGist,
    shareUrlForGist,
    type GistRef,
} from "../share/gist.ts";
import {
    formatSharePreview,
    formatShareSuccess,
    formatStaleUsageWarning,
    hasStaleUsage,
} from "../share/format.ts";
import { redactShareArtifact } from "../share/redact.ts";
import {
    ingestShareTranscript,
    locateShareTranscript,
    type ShareIngestOutcome,
    type ShareTranscriptHit,
} from "../share/recover.ts";
import { IngestRuntimeLayer } from "../ingest/stage/runtime.ts";
import { AX_VERSION } from "./version.ts";
import { catchDbErrorAndExit } from "./output.ts";

export interface ShareArgs {
    readonly sessionId: string;
    readonly dryRun: boolean;
    readonly open: boolean;
    readonly public: boolean;
    readonly yes: boolean;
}

export interface ShareCommandDeps {
    readonly exportArtifact: (
        sessionId: string,
        axVersion: string,
    ) => Promise<AxSessionShare | null>;
    /** Find the session's on-disk transcript when it isn't in the graph. */
    readonly locateTranscript: (
        sessionId: string,
    ) => Promise<ShareTranscriptHit | null>;
    /** Targeted ingest of a located transcript (single-flight locked). */
    readonly ingestSession: (
        hit: ShareTranscriptHit,
    ) => Promise<ShareIngestOutcome>;
    readonly publish: (input: {
        readonly bundle: ShareBundle;
        readonly public: boolean;
    }) => Promise<GistRef>;
    readonly open: (ref: GistRef) => Promise<void>;
    readonly writeStdout: (text: string) => void;
    readonly writeStderr: (text: string) => void;
    readonly setExitCode: (code: number) => void;
    readonly clearExitCode: () => void;
}

const SHARE_USAGE = [
    "usage: axctl share <session-id> [--dry-run] [--public] [--open] [--yes]",
].join("\n");

const KNOWN_FLAGS = new Set(["--dry-run", "--open", "--public", "--yes"]);

export function parseShareArgs(args: ReadonlyArray<string>): ShareArgs {
    const positionals: string[] = [];

    for (const arg of args) {
        if (arg.startsWith("--")) {
            if (!KNOWN_FLAGS.has(arg)) throw new Error(`unknown flag ${arg}`);
            continue;
        }
        if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
        positionals.push(arg);
    }

    const sessionId = positionals[0];
    if (sessionId === undefined) throw new Error("missing <session-id>");
    if (positionals.length > 1) throw new Error(`unexpected argument ${positionals[1]}`);

    return {
        sessionId,
        dryRun: args.includes("--dry-run"),
        open: args.includes("--open"),
        public: args.includes("--public"),
        yes: args.includes("--yes"),
    };
}

const openShareUrl = async (ref: GistRef): Promise<void> => {
    if (process.platform !== "darwin") return;

    await new Promise<void>((resolve) => {
        const child = execFile("open", [shareUrlForGist(ref)], () => resolve());
        child.on("error", () => resolve());
    });
};

/**
 * Export-miss fallback: find the transcript on disk, run a targeted ingest
 * for it (claude: scoped to its project dir; codex: --since window), then
 * retry the export once. Every failure mode writes its own stderr message and
 * sets exit code 1; returns the recovered artifact or null.
 */
async function recoverMissingSession(
    sessionId: string,
    deps: ShareCommandDeps,
): Promise<AxSessionShare | null> {
    const hit = await deps.locateTranscript(sessionId);
    if (hit === null) {
        deps.writeStderr(`axctl share: session ${sessionId} not found\n`);
        deps.setExitCode(1);
        return null;
    }

    deps.writeStderr(
        `axctl share: session ${sessionId} not in graph - ingesting it now…\n`,
    );
    const outcome = await deps.ingestSession(hit);
    if (outcome.kind === "busy") {
        deps.writeStderr(
            `axctl share: session ${sessionId} not in graph and another ingest ` +
                `(pid ${outcome.pid}, ${outcome.command}) is in progress; ` +
                `re-run ax share once it finishes\n`,
        );
        deps.setExitCode(1);
        return null;
    }
    if (outcome.kind === "failed") {
        deps.writeStderr(
            `axctl share: session ${sessionId} not found ` +
                `(targeted ingest of ${hit.path} failed: ${outcome.message})\n`,
        );
        deps.setExitCode(1);
        return null;
    }

    const exported = await deps.exportArtifact(sessionId, AX_VERSION);
    if (exported === null) {
        deps.writeStderr(
            `axctl share: session ${sessionId} not found ` +
                `(ingested ${hit.path}, but the session still did not appear in the graph)\n`,
        );
        deps.setExitCode(1);
        return null;
    }
    return exported;
}

export async function cmdShareWithDeps(
    args: string[],
    deps: ShareCommandDeps,
): Promise<void> {
    let parsed: ShareArgs;
    try {
        parsed = parseShareArgs(args);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.writeStderr(`axctl share: ${message}\n${SHARE_USAGE}\n`);
        deps.setExitCode(2);
        return;
    }
    deps.clearExitCode();

    let exported = await deps.exportArtifact(parsed.sessionId, AX_VERSION);
    if (exported === null) {
        // Export miss (#270): the session a user most wants to share - the
        // live one - is by definition not yet ingested. Locate its transcript
        // on disk, run a targeted ingest, then retry the export once.
        exported = await recoverMissingSession(parsed.sessionId, deps);
        if (exported === null) return; // recoverMissingSession wrote the error + exit code
    }

    const { artifact } = redactShareArtifact(exported);
    const bundle = buildShareBundle(artifact);

    if (hasStaleUsage(artifact)) {
        deps.writeStderr(formatStaleUsageWarning());
    }

    if (parsed.dryRun) {
        // Emit the full multi-file bundle keyed by gist filename so the dry-run
        // shows exactly what would be published (manifest + every part).
        const byFile = Object.fromEntries(bundle.files.map((file) => [file.name, file.content]));
        deps.writeStdout(`${prettyPrint(byFile)}\n`);
        return;
    }

    deps.writeStderr(`${formatSharePreview(artifact, { public: parsed.public })}\n`);

    if (!parsed.yes) {
        const visibility = parsed.public ? "public" : "secret/unlisted";
        deps.writeStderr(`Re-run with --yes to publish this ${visibility} Gist.\n`);
        deps.setExitCode(2);
        return;
    }

    let ref: GistRef;
    try {
        ref = await deps.publish({
            bundle,
            public: parsed.public,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.writeStderr(`axctl share: ${message}\n`);
        deps.setExitCode(1);
        return;
    }

    deps.writeStdout(`${formatShareSuccess(ref)}\n`);
    if (parsed.open) await deps.open(ref);
}

const liveShareDeps: ShareCommandDeps = {
    exportArtifact: (sessionId, axVersion) =>
        Effect.runPromise(
            exportSessionShare(sessionId, axVersion).pipe(
                catchDbErrorAndExit("axctl share"),
                Effect.provide(AppLayer),
                Effect.scoped,
            ),
        ),
    locateTranscript: (sessionId) =>
        Effect.runPromise(
            locateShareTranscript(sessionId).pipe(
                Effect.provide(AppLayer),
                Effect.scoped,
            ),
        ),
    ingestSession: (hit) =>
        Effect.runPromise(
            ingestShareTranscript(hit).pipe(
                // The ingest pipeline needs the stage registry on top of the
                // app services - same runtime layer `ax ingest` runs under.
                Effect.provide(IngestRuntimeLayer),
                Effect.scoped,
            ),
        ),
    publish: (input) => Effect.runPromise(createSessionGist(input)),
    open: openShareUrl,
    writeStdout: (text) => {
        process.stdout.write(text);
    },
    writeStderr: (text) => {
        process.stderr.write(text);
    },
    setExitCode: (code) => {
        process.exitCode = code;
    },
    clearExitCode: () => {
        process.exitCode = 0;
    },
};

export async function cmdShare(args: string[]): Promise<void> {
    await cmdShareWithDeps(args, liveShareDeps);
}
