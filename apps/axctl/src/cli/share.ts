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

    const exported = await deps.exportArtifact(parsed.sessionId, AX_VERSION);
    if (exported === null) {
        deps.writeStderr(`axctl share: session ${parsed.sessionId} not found\n`);
        deps.setExitCode(1);
        return;
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
