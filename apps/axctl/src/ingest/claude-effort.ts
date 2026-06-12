/**
 * Claude effort-level capture.
 *
 * Claude Code persists NO per-session or per-turn effort field in transcripts
 * - the only source is the machine-global `~/.claude/settings.json`
 * `effortLevel` (high|medium|low), which reflects the CURRENT setting. To
 * avoid stamping today's setting onto historical sessions, the stamp is
 * applied only to sessions still active within a freshness window of the
 * ingest run (the watcher ingests within ~1min of activity, so live sessions
 * get an accurate value; backfilled history stays NONE).
 */
import { Effect, FileSystem } from "effect";
import { posixPath } from "@ax/lib/shared/path";
import { HOME } from "@ax/lib/paths";

export const claudeSettingsPath = (): string =>
    process.env.AX_CLAUDE_SETTINGS ?? posixPath.join(HOME, ".claude", "settings.json");

/** Extract `effortLevel` from a settings.json body; null when absent/invalid. */
export const parseEffortLevel = (settingsJson: string): string | null => {
    try {
        const parsed = JSON.parse(settingsJson) as Record<string, unknown>;
        const level = parsed.effortLevel;
        return typeof level === "string" && level.trim().length > 0 ? level.trim() : null;
    } catch {
        return null;
    }
};

const DEFAULT_FRESHNESS_MS = 30 * 60_000;

/**
 * The effort value to stamp on a session, or undefined (encodes NONE).
 * Stamped only when the session was active within `freshnessMs` of now -
 * the global setting is only trustworthy for currently-running sessions.
 */
export const claudeEffortStamp = (
    effortLevel: string | null,
    endedAt: string | null,
    nowMs: number,
    freshnessMs: number = DEFAULT_FRESHNESS_MS,
): string | undefined => {
    if (!effortLevel || !endedAt) return undefined;
    const ended = Date.parse(endedAt);
    if (!Number.isFinite(ended)) return undefined;
    return nowMs - ended <= freshnessMs ? effortLevel : undefined;
};

/** Read the current effortLevel; missing/unreadable settings degrade to null. */
export const loadClaudeEffortLevel: Effect.Effect<string | null, never, FileSystem.FileSystem> =
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const content = yield* fs.readFileString(claudeSettingsPath()).pipe(
            Effect.orElseSucceed(() => null as string | null),
        );
        return content === null ? null : parseEffortLevel(content);
    });
