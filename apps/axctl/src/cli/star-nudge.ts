// Post-command star/feedback disclosure for the CLI.
//
// Skills don't fire deterministically, so the "consider starring / file an
// issue" nudge lives here in the CLI exit path instead. It is best-effort and
// must NEVER break a command: it only prints to stderr, only on an interactive
// terminal, at most once a day, and goes silent forever once the user stars
// (`ax star`) or dismisses it (`ax star --done`). Agents and the background
// watcher run non-TTY, so they never see it.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REPO = "Necmttn/ax";
const REPO_URL = `https://github.com/${REPO}`;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const dataDir = (): string => process.env.AX_DATA_DIR ?? join(homedir(), ".local", "share", "ax");
const statePath = (): string => join(dataDir(), "nudge-state.json");

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

function readState(): NudgeState {
    try {
        if (!existsSync(statePath())) return {};
        return JSON.parse(readFileSync(statePath(), "utf8")) as NudgeState;
    } catch {
        return {};
    }
}

function writeState(next: NudgeState): void {
    try {
        mkdirSync(dataDir(), { recursive: true });
        writeFileSync(statePath(), `${JSON.stringify(next, null, 2)}\n`);
    } catch {
        // best-effort; a read-only data dir must not break the CLI
    }
}

/** Best-effort post-command footer. Never throws. */
export function maybePrintStarNudge(argv: readonly string[]): void {
    try {
        const env = readNudgeEnv();
        const state = readState();
        const now = Date.now();
        if (!shouldShowNudge(state, env, argv, now)) return;
        process.stderr.write(`${renderNudge()}\n`);
        writeState({ ...state, lastShownAt: now, shownCount: (state.shownCount ?? 0) + 1 });
    } catch {
        // the nudge must never break the CLI
    }
}

/**
 * `ax star [--done]` - star the repo via `gh`, or just mark it starred/dismissed
 * so the reminder stops. Hidden command; the nudge text points users at it.
 */
export async function cmdStar(args: readonly string[]): Promise<void> {
    if (args.includes("--done") || args.includes("--starred")) {
        writeState({ ...readState(), starred: true });
        console.log("Thanks - hiding the star reminder.");
        return;
    }
    const { spawnSync } = await import("node:child_process");
    const auth = spawnSync("gh", ["auth", "status"], { stdio: "ignore" });
    if (auth.status === 0) {
        const put = spawnSync("gh", ["api", "-X", "PUT", `/user/starred/${REPO}`], { stdio: "ignore" });
        if (put.status === 0) {
            writeState({ ...readState(), starred: true });
            console.log(`★ Starred ${REPO} - thank you!`);
            return;
        }
    }
    console.log(`Open ${REPO_URL} and click Star to support ax.`);
    console.log("Already starred? run `ax star --done` to hide the reminder.");
}
