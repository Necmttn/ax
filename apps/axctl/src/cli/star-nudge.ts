// Post-command star/feedback disclosure for the CLI.
//
// Skills don't fire deterministically, so the "consider starring / file an
// issue" nudge lives here in the CLI exit path instead. It is best-effort and
// must NEVER break a command: it only prints to stderr, only on an interactive
// terminal, at most once a day, and goes silent forever once the user stars
// (`ax star`) or dismisses it (`ax star --done`). Agents and the background
// watcher run non-TTY, so they never see it.

import { Effect, FileSystem, Layer, Schema } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { jsonField } from "@ax/lib/decode";
import { prettyPrint } from "@ax/lib/json";
import { homedir } from "node:os";
import { orAbsent } from "@ax/lib/shared/fs-error";
import { posixPath } from "@ax/lib/shared/path";

const REPO = "Necmttn/ax";
const REPO_URL = `https://github.com/${REPO}`;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const dataDir = (): string => process.env.AX_DATA_DIR ?? posixPath.join(homedir(), ".local", "share", "ax");
const statePath = (): string => posixPath.join(dataDir(), "nudge-state.json");

// Best-effort I/O runs on the real Bun-backed filesystem, the same backing the
// CLI uses everywhere else. These ops are intentionally side-effect-isolated:
// the nudge must never break the CLI, so every failure is swallowed.
const BunFsLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);

export interface NudgeState {
    /** Set once the user stars or dismisses - the nudge never shows again. */
    readonly starred?: boolean;
    readonly lastShownAt?: number;
    readonly shownCount?: number;
}

export interface NudgeEnv {
    readonly isTTY: boolean;
    readonly ci: boolean;
    readonly silenced: boolean;
}

// Only nudge AFTER ax delivered something useful - an ingest that filled the
// graph, a query that surfaced sessions/skills, a retro, an improve proposal.
// Maintenance/own-UI/machine commands (install, doctor, daemon, update, tui,
// serve, star, version, ...) are NOT value moments, so they never nudge.
const VALUE_COMMANDS = new Set([
    "ingest",
    "recall",
    "sessions",
    "skills",
    "improve",
    "retro",
    "insights",
    "report",
    "roles",
    "evidence",
    "costs",
]);

export function readNudgeEnv(): NudgeEnv {
    return {
        isTTY: Boolean(process.stderr.isTTY),
        ci: Boolean(process.env.CI),
        silenced:
            process.env.AX_NO_NUDGE === "1" || (process.env.AX_NUDGE ?? "").toLowerCase() === "off",
    };
}

/**
 * Pure decision - no I/O - so it is cheap to unit-test. Show the nudge only to
 * a human at an interactive terminal, never for help/json/skip commands, never
 * once dismissed, and at most once per 24h.
 */
export function shouldShowNudge(
    state: NudgeState,
    env: NudgeEnv,
    argv: readonly string[],
    now: number,
): boolean {
    if (env.silenced || env.ci || !env.isTTY) return false;
    if (state.starred) return false;
    const cmd = argv[0];
    if (!cmd || cmd.startsWith("-")) return false;
    if (argv.includes("--help") || argv.includes("-h")) return false;
    if (argv.includes("--json")) return false;
    if (!VALUE_COMMANDS.has(cmd)) return false;
    if (now - (state.lastShownAt ?? 0) < ONE_DAY_MS) return false;
    return true;
}

export function renderNudge(): string {
    return [
        "",
        "  ──────────────────────────────",
        `  ★ Find ax useful? A star helps it grow → ${REPO_URL}`,
        `    Feedback or a bug? ${REPO_URL}/issues/new`,
        "    Already starred? `ax star --done` hides this · silence: AX_NO_NUDGE=1",
        "",
    ].join("\n");
}

// optionalKey (exact-optional, no `| undefined`) matches NudgeState under
// exactOptionalPropertyTypes.
const nudgeStateField = jsonField(Schema.Struct({
    starred: Schema.optionalKey(Schema.Boolean),
    lastShownAt: Schema.optionalKey(Schema.Number),
    shownCount: Schema.optionalKey(Schema.Number),
}));

const readState = (): Effect.Effect<NudgeState, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // Original: existsSync-guard + readFileSync in a try/catch, ANY error
        // (missing file, unreadable, malformed/mistyped JSON) -> {}.
        const raw = yield* fs.readFileString(statePath()).pipe(orAbsent<string | null>(null));
        return nudgeStateField.decode(raw) ?? {};
    });

const writeState = (next: NudgeState): Effect.Effect<void, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // best-effort; a read-only data dir must not break the CLI
        yield* fs.makeDirectory(dataDir(), { recursive: true }).pipe(orAbsent<void>(undefined));
        yield* fs
            .writeFileString(statePath(), `${prettyPrint(next)}\n`)
            .pipe(orAbsent<void>(undefined));
    });

/** Best-effort post-command footer. Never throws. */
export function maybePrintStarNudge(argv: readonly string[]): Promise<void> {
    const program = Effect.gen(function* () {
        const env = readNudgeEnv();
        const state = yield* readState();
        const now = Date.now();
        if (!shouldShowNudge(state, env, argv, now)) return;
        process.stderr.write(`${renderNudge()}\n`);
        yield* writeState({ ...state, lastShownAt: now, shownCount: (state.shownCount ?? 0) + 1 });
    }).pipe(
        Effect.provide(BunFsLayer),
        // the nudge must never break the CLI
        Effect.ignore,
    );
    return Effect.runPromise(program);
}

/**
 * `ax star [--done]` - star the repo via `gh`, or just mark it starred/dismissed
 * so the reminder stops. Hidden command; the nudge text points users at it.
 */
export async function cmdStar(args: readonly string[]): Promise<void> {
    const markStarred = (): Promise<void> =>
        Effect.runPromise(
            Effect.gen(function* () {
                const state = yield* readState();
                yield* writeState({ ...state, starred: true });
            }).pipe(Effect.provide(BunFsLayer)),
        );

    if (args.includes("--done") || args.includes("--starred")) {
        await markStarred();
        console.log("Thanks - hiding the star reminder.");
        return;
    }
    const { spawnSync } = await import("node:child_process");
    const auth = spawnSync("gh", ["auth", "status"], { stdio: "ignore" });
    if (auth.status === 0) {
        const put = spawnSync("gh", ["api", "-X", "PUT", `/user/starred/${REPO}`], { stdio: "ignore" });
        if (put.status === 0) {
            await markStarred();
            console.log(`★ Starred ${REPO} - thank you!`);
            return;
        }
    }
    console.log(`Open ${REPO_URL} and click Star to support ax.`);
    console.log("Already starred? run `ax star --done` to hide the reminder.");
}
