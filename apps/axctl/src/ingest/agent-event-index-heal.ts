/**
 * Self-heal for the `agent_event_session_seq` UNIQUE index (#680).
 *
 * `agent_event` carries `DEFINE INDEX agent_event_session_seq ON agent_event
 * FIELDS agent_session, seq UNIQUE`. `seq` is a POSITIONAL counter recomputed
 * from 0 on every parse, so it drifts across ingests. The per-session clear
 * (`buildAgentSessionEventClearStatements`) deletes a session's rows by PRIMARY
 * id before re-insert, which is enough for row-level drift - BUT a long-lived
 * DB (observed across a SurrealDB version change / older ax) can accumulate
 * GHOST index entries: `(agent_session, seq)` pairs in the index whose backing
 * row is already gone. A delete-by-primary-id cannot remove a ghost (there is
 * no row to enumerate), yet the ghost still blocks the fresh `(session, seq)`
 * INSERT. The result is a permanent skip loop: the file's watermark never
 * commits (per-file isolation swallows the DbError), so the SAME file fails
 * identically every run until the index is rebuilt.
 *
 * `REBUILD INDEX` rebuilds the index from live table data, discarding ghost
 * entries - the one repair that actually clears the condition. We run it at
 * most ONCE per stage (guarded by a shared `state.repaired`) and retry the
 * failing file once; a second failure falls back to the existing skip-and-retry
 * behavior after recording an unhealthy marker that `ax doctor` surfaces with
 * the manual remediation.
 *
 * The pure planners + the wrapper are unit-tested with a fake client (no live
 * SurrealDB). Kept small + composable on purpose (#675 is adjacent).
 */

import { Effect, FileSystem } from "effect";
import type { SurrealClientShape } from "@ax/lib/db";
import { DbError } from "@ax/lib/errors";
import { safeJsonParse } from "@ax/lib/shared/safe-json";

export const AGENT_EVENT_SEQ_INDEX = "agent_event_session_seq";

/**
 * Liberal match: SurrealDB duplicate-index error strings shift across versions
 * ("already contains", "Database index ... violates ...", etc.), so we key only
 * on the index NAME appearing in a {@link DbError} message.
 */
export const isAgentEventSeqDuplicateError = (err: unknown): boolean =>
    err instanceof DbError && err.message.includes(AGENT_EVENT_SEQ_INDEX);

/** Best-effort extraction of the offending `agent_session` id for logging /
 *  the doctor marker. Handles both bare and ⟨angle-bracket⟩ record forms. */
export const extractAgentSessionId = (message: string): string | null => {
    const m = message.match(/agent_session:[`⟨]?([A-Za-z0-9_.:-]+?)[`⟩\]',\s]/);
    return m ? m[1] : null;
};

/**
 * One-shot ghost-index repair. `REBUILD INDEX` drops index entries with no
 * backing row (a clear-by-primary-id can't). `IF EXISTS` so a fresh DB without
 * the index no-ops instead of erroring. This is the deliberate choice over
 * `DELETE ... by primary id`: that path is what already runs before insert and
 * still leaves ghosts. Runs on a possibly-large table and briefly locks it, so
 * it fires at most once per stage (see {@link withAgentEventSeqHeal}).
 */
export const buildAgentEventSeqRepairStatements = (): readonly string[] => [
    `REBUILD INDEX IF EXISTS ${AGENT_EVENT_SEQ_INDEX} ON agent_event;`,
];

/** Doctor-actionable manual remediation naming the exact statement. */
export const AGENT_EVENT_SEQ_REPAIR_HINT =
    `agent_event ${AGENT_EVENT_SEQ_INDEX} index has residual ghost entries; ` +
    `run \`REBUILD INDEX ${AGENT_EVENT_SEQ_INDEX} ON agent_event\` against the ax DB to clear them`;

/** Shared per-stage guard so the rebuild fires at most once across all files. */
export interface AgentEventSeqHealState {
    repaired: boolean;
}

export interface AgentEventSeqHealHooks {
    readonly db: SurrealClientShape;
    readonly state: AgentEventSeqHealState;
    /** Called just before the (single) rebuild is issued. */
    readonly onRepairAttempt?: (sessionId: string | null) => Effect.Effect<void>;
    /** Called when a retry STILL fails on the same signature (record marker). */
    readonly onExhausted?: (sessionId: string | null) => Effect.Effect<void>;
    /** Called when the retry succeeds (clear marker). */
    readonly onHealed?: () => Effect.Effect<void>;
}

/**
 * Wrap one file's ingest effect. On a duplicate-index {@link DbError}:
 *   1. REBUILD the index once per stage (guarded by `state.repaired`),
 *   2. retry the effect ONCE,
 *   3. on a second matching failure, call `onExhausted` and rethrow so the
 *      caller's per-file isolation skips + retries next run.
 * Non-matching failures pass through untouched (no rebuild, no retry).
 */
export const withAgentEventSeqHeal = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    hooks: AgentEventSeqHealHooks,
): Effect.Effect<A, E | DbError, R> =>
    effect.pipe(
        Effect.catch((err): Effect.Effect<A, E | DbError, R> => {
            if (!isAgentEventSeqDuplicateError(err)) return Effect.fail(err as E);
            const sessionId = extractAgentSessionId((err as DbError).message);
            return Effect.gen(function* () {
                if (!hooks.state.repaired) {
                    hooks.state.repaired = true;
                    if (hooks.onRepairAttempt) yield* hooks.onRepairAttempt(sessionId);
                    yield* Effect.logWarning(
                        `agent_event index ${AGENT_EVENT_SEQ_INDEX} duplicate - rebuilding once, then retrying`,
                        { sessionId },
                    );
                    yield* hooks.db.query(buildAgentEventSeqRepairStatements().join("\n"));
                }
                return yield* effect.pipe(
                    Effect.tap(() => (hooks.onHealed ? hooks.onHealed() : Effect.void)),
                    Effect.catch((err2): Effect.Effect<A, E | DbError, R> => {
                        if (!isAgentEventSeqDuplicateError(err2)) return Effect.fail(err2 as E);
                        return (hooks.onExhausted ? hooks.onExhausted(sessionId) : Effect.void).pipe(
                            Effect.andThen(Effect.logWarning(
                                `agent_event index still blocked after rebuild; ${AGENT_EVENT_SEQ_REPAIR_HINT}`,
                                { sessionId },
                            )),
                            Effect.andThen(Effect.fail(err2 as DbError)),
                        );
                    }),
                );
            });
        }),
    );

// --- Doctor marker (cheap fs surface, no query) -------------------------------

export interface IndexUnhealthyMarker {
    readonly session_id: string | null;
    readonly message: string;
    readonly at: string;
}

/** Marker path under the ax data dir. Trailing slashes normalized. */
export const agentEventIndexMarkerPath = (dataDir: string): string =>
    `${dataDir.replace(/\/+$/, "")}/agent-event-index.unhealthy.json`;

export const writeIndexUnhealthyMarker = (
    dataDir: string,
    sessionId: string | null,
    message: string,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const marker: IndexUnhealthyMarker = { session_id: sessionId, message, at: new Date().toISOString() };
        yield* fs.writeFileString(agentEventIndexMarkerPath(dataDir), JSON.stringify(marker, null, 2)).pipe(
            Effect.ignore,
        );
    });

export const clearIndexUnhealthyMarker = (
    dataDir: string,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(agentEventIndexMarkerPath(dataDir)).pipe(Effect.ignore);
    });

export const readIndexUnhealthyMarker = (
    dataDir: string,
): Effect.Effect<IndexUnhealthyMarker | null, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const text = yield* fs.readFileString(agentEventIndexMarkerPath(dataDir)).pipe(
            Effect.orElseSucceed(() => ""),
        );
        if (!text) return null;
        return safeJsonParse<IndexUnhealthyMarker>(text) ?? null;
    });

/** Pure doctor verdict from the (already-read) marker. */
export const agentEventIndexDoctorCheck = (
    marker: IndexUnhealthyMarker | null,
): { name: string; ok: boolean; detail: string } =>
    marker === null
        ? { name: "agent-event-index", ok: true, detail: `${AGENT_EVENT_SEQ_INDEX} healthy` }
        : {
            name: "agent-event-index",
            ok: false,
            detail:
                `codex ingest hit a residual ghost entry in ${AGENT_EVENT_SEQ_INDEX} ` +
                `(session ${marker.session_id ?? "?"}, at ${marker.at}) that auto-rebuild couldn't clear; ` +
                `run \`REBUILD INDEX ${AGENT_EVENT_SEQ_INDEX} ON agent_event\` against the ax DB`,
        };
