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
 * The heal is a small ladder, cheapest rung first (see {@link withAgentEventSeqHeal}):
 *   1. **Dedupe THIS session by primary id** ({@link planSessionDedup}, the same
 *      pure planner the global repair script uses). Targeted, lock-free, cheap -
 *      it clears real duplicate rows. Retry the file once.
 *   2. **Rebuild the index** if the retry still collides (a true ghost with no
 *      backing row to dedupe). `REBUILD INDEX ... CONCURRENTLY` returns
 *      immediately and builds in the background (a plain rebuild locks the whole
 *      table, which on a millions-row `agent_event` wedges the daemon - the same
 *      hazard the otel indexes avoid). We poll `INFO FOR INDEX` readiness with a
 *      bounded budget, fire the rebuild AT MOST ONCE per stage via a shared
 *      memoized Effect (`Effect.cached`: concurrent files await one in-flight
 *      rebuild, and a failed rebuild is cached + observable, never re-run).
 *      Retry the file once more.
 *   3. **Doctor marker + rethrow** if it STILL collides. `ax doctor` surfaces the
 *      marker pointing at the global `bun scripts/repair-agent-event-index.ts`.
 *
 * The pure planners + the wrapper are unit-tested with a fake client (no live
 * SurrealDB). Kept small + composable on purpose (#675 is adjacent).
 */

import { Effect, FileSystem } from "effect";
import type { SurrealClientShape } from "@ax/lib/db";
import { DbError } from "@ax/lib/errors";
import { skipNotFound } from "@ax/lib/shared/fs-error";
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

/** Normalize an `agent_session` id to the bare key (no `agent_session:` prefix,
 *  no backtick / angle-bracket wrappers) for safe interpolation into a ref. */
const agentSessionKey = (id: string): string =>
    id
        .replace(/^agent_session:/, "")
        .replace(/^`|`$/g, "")
        .replace(/^⟨|⟩$/g, "");

// --- Ladder step 1: per-session dedupe by primary id --------------------------

/**
 * Excess record ids to delete for one session: keep the first row at each seq,
 * drop the rest. Pure so it can be reasoned about / unit-tested in isolation.
 * One owner - `scripts/repair-agent-event-index.ts` imports this (the global
 * repair and the ingest-time heal dedupe by the SAME rule, no copy).
 */
export const planSessionDedup = (
    rows: ReadonlyArray<{ readonly id: string; readonly seq: number }>,
): string[] => {
    const seen = new Set<number>();
    const drop: string[] = [];
    for (const row of rows) {
        if (seen.has(row.seq)) drop.push(row.id);
        else seen.add(row.seq);
    }
    return drop;
};

/** SELECT that enumerates one session's `(id, seq)` rows by the full-table
 *  predicate (never the corruptible secondary index). */
export const buildSessionDedupSelect = (sessionId: string): string =>
    `SELECT id, seq FROM agent_event WHERE agent_session = agent_session:\`${agentSessionKey(sessionId)}\`;`;

/** Dedupe one session's rows by primary id. Returns the count removed. */
const dedupeSession = (
    db: SurrealClientShape,
    sessionId: string,
): Effect.Effect<number, DbError> =>
    Effect.gen(function* () {
        const rows = yield* db
            .query<[Array<{ id: string; seq: number }>]>(buildSessionDedupSelect(sessionId))
            .pipe(Effect.map((r) => r?.[0] ?? []));
        const drop = planSessionDedup(rows.map((row) => ({ id: String(row.id), seq: row.seq })));
        // Batched to stay under parser limits (mirrors the repair script).
        for (let i = 0; i < drop.length; i += 200) {
            const batch = drop.slice(i, i + 200);
            yield* db.query(batch.map((id) => `DELETE ${id};`).join(""));
        }
        return drop.length;
    });

// --- Ladder step 2: shared, non-blocking index rebuild ------------------------

/**
 * `REBUILD INDEX ... CONCURRENTLY` (verified supported on SurrealDB 3.2:
 * https://surrealdb.com/docs/surrealql/statements/rebuild) rebuilds from live
 * table data - dropping ghost entries - WITHOUT locking the table. `IF EXISTS`
 * so a fresh DB no-ops. The DEFINE shape stays consistent with
 * packages/schema/src/schema.surql (UNIQUE, same fields).
 */
export const buildAgentEventSeqRebuildStatement = (): string =>
    `REBUILD INDEX IF EXISTS ${AGENT_EVENT_SEQ_INDEX} ON agent_event CONCURRENTLY;`;

/** ~30s budget (1s interval) to poll a CONCURRENTLY rebuild to readiness. */
const MAX_INDEX_POLL_ATTEMPTS = 30;

/** `INFO FOR INDEX` reports `{ building: { status } }` while a CONCURRENTLY
 *  build runs; an empty/absent `building` (or a plain non-concurrent build)
 *  means ready. An unreadable INFO recovers to "ready" so we never poll
 *  forever on a probe error. */
interface IndexBuildInfo {
    readonly building?: { readonly status?: string } | null;
}

const isIndexReady = (db: SurrealClientShape): Effect.Effect<boolean> =>
    db
        .query<[IndexBuildInfo | null]>(`INFO FOR INDEX ${AGENT_EVENT_SEQ_INDEX} ON agent_event;`)
        .pipe(
            Effect.map((r) => {
                const status = r?.[0]?.building?.status;
                return !status || status === "ready";
            }),
            Effect.orElseSucceed(() => true),
        );

const waitIndexReady = (
    db: SurrealClientShape,
    attempts = MAX_INDEX_POLL_ATTEMPTS,
): Effect.Effect<void> =>
    attempts <= 0
        ? Effect.void
        : isIndexReady(db).pipe(
              Effect.flatMap((ready) =>
                  ready
                      ? Effect.void
                      : Effect.sleep("1 second").pipe(
                            Effect.andThen(waitIndexReady(db, attempts - 1)),
                        ),
              ),
          );

/**
 * Build the SHARED per-stage rebuild Effect: rebuild CONCURRENTLY then poll to
 * readiness. Wrapped in {@link Effect.cached} (F2) so ALL files await one
 * in-flight rebuild - a failed rebuild is cached and observable, and the
 * rebuild fires at most once even under file concurrency > 1. Yield this once
 * per stage and hand the inner Effect to every file's {@link withAgentEventSeqHeal}.
 */
export const makeAgentEventSeqRebuild = (
    db: SurrealClientShape,
): Effect.Effect<Effect.Effect<void, DbError>> =>
    Effect.cached(
        Effect.gen(function* () {
            yield* Effect.logWarning(
                `rebuilding ${AGENT_EVENT_SEQ_INDEX} CONCURRENTLY (ghost-index heal, once per stage)`,
            );
            yield* db.query(buildAgentEventSeqRebuildStatement());
            yield* waitIndexReady(db);
        }),
    );

// --- The heal ladder ----------------------------------------------------------

/** Doctor-actionable manual remediation naming the global repair script. */
export const AGENT_EVENT_SEQ_REPAIR_HINT =
    `agent_event ${AGENT_EVENT_SEQ_INDEX} index has residual ghost entries an auto-rebuild couldn't clear; ` +
    `run \`bun scripts/repair-agent-event-index.ts\` against the ax DB (dedupes by primary id, rebuilds the index)`;

export interface AgentEventSeqHealHooks {
    readonly db: SurrealClientShape;
    /**
     * SHARED, memoized index rebuild from {@link makeAgentEventSeqRebuild}.
     * Fires at most once per stage (Effect.cached dedups in-flight + caches a
     * failure), so file concurrency can't launch overlapping rebuilds.
     */
    readonly rebuild: Effect.Effect<void, DbError>;
    /** Called after step-1 dedupe (removed = rows dropped by primary id). */
    readonly onDedupe?: (sessionId: string, removed: number) => Effect.Effect<void>;
    /** Called after the shared rebuild completes (before the second retry). */
    readonly onRebuild?: () => Effect.Effect<void>;
    /** Called when the ladder is exhausted (record the doctor marker). */
    readonly onExhausted?: (sessionId: string | null) => Effect.Effect<void>;
    /** Called when a retry SUCCEEDS (clear the doctor marker). */
    readonly onHealed?: () => Effect.Effect<void>;
}

/**
 * Wrap one file's ingest effect. On a duplicate-index {@link DbError}, walk the
 * dedupe -> rebuild -> marker ladder (see the module doc). Non-matching failures
 * pass through untouched (no dedupe, no rebuild, no retry).
 */
export const withAgentEventSeqHeal = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    hooks: AgentEventSeqHealHooks,
): Effect.Effect<A, E | DbError, R> => {
    const withHealClear = (e: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
        e.pipe(Effect.tap(() => (hooks.onHealed ? hooks.onHealed() : Effect.void)));

    const exhausted = (sessionId: string | null, err: DbError): Effect.Effect<never, DbError> =>
        (hooks.onExhausted ? hooks.onExhausted(sessionId) : Effect.void).pipe(
            Effect.andThen(
                Effect.logWarning(
                    `agent_event index still blocked after heal; ${AGENT_EVENT_SEQ_REPAIR_HINT}`,
                    { sessionId },
                ),
            ),
            Effect.andThen(Effect.fail(err)),
        );

    return effect.pipe(
        Effect.catch((err): Effect.Effect<A, E | DbError, R> => {
            if (!isAgentEventSeqDuplicateError(err)) return Effect.fail(err as E);
            const sessionId = extractAgentSessionId((err as DbError).message);
            return Effect.gen(function* () {
                // Step 1: dedupe THIS session by primary id (cheap, targeted,
                // lock-free). A true ghost has no backing row to drop, so it
                // falls through to the rebuild on the retry below.
                if (sessionId) {
                    const removed = yield* dedupeSession(hooks.db, sessionId);
                    if (hooks.onDedupe) yield* hooks.onDedupe(sessionId, removed);
                    yield* Effect.logWarning(
                        `agent_event ${AGENT_EVENT_SEQ_INDEX} duplicate - deduped session by primary id, retrying`,
                        { sessionId, removed },
                    );
                }
                // NOTE (accepted tradeoff): a retry re-runs this file's clear +
                // insert, so stage counters can double-count on the rare heal
                // path. Stats-only; the DB writes converge (clear is idempotent).
                return yield* withHealClear(effect).pipe(
                    Effect.catch((err2): Effect.Effect<A, E | DbError, R> => {
                        if (!isAgentEventSeqDuplicateError(err2)) return Effect.fail(err2 as E);
                        // Step 2: shared, memoized, non-blocking rebuild (once
                        // per stage). A failed rebuild is surfaced to doctor.
                        return hooks.rebuild.pipe(
                            Effect.catch((rebuildErr: DbError) => exhausted(sessionId, rebuildErr)),
                            Effect.andThen(hooks.onRebuild ? hooks.onRebuild() : Effect.void),
                            Effect.andThen(
                                withHealClear(effect).pipe(
                                    Effect.catch((err3): Effect.Effect<A, E | DbError, R> => {
                                        if (!isAgentEventSeqDuplicateError(err3)) {
                                            return Effect.fail(err3 as E);
                                        }
                                        // Step 3: still blocked -> marker + rethrow.
                                        return exhausted(sessionId, err3 as DbError);
                                    }),
                                ),
                            ),
                        );
                    }),
                );
            });
        }),
    );
};

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

/**
 * Read the marker. Only a MISSING file reads as "absent/healthy" (null). A
 * present-but-unreadable file or malformed JSON is NOT silently healthy: it
 * logs a warning and falls open to null (F3 - fail-open but not blind).
 */
export const readIndexUnhealthyMarker = (
    dataDir: string,
): Effect.Effect<IndexUnhealthyMarker | null, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = agentEventIndexMarkerPath(dataDir);
        const text = yield* fs.readFileString(path).pipe(
            // Missing file -> healthy (null), silently.
            skipNotFound(null as string | null),
            // Any other read error -> logged, fall open to null (not blind).
            Effect.catchTag("PlatformError", (e) =>
                Effect.logWarning("agent-event-index marker present but unreadable", {
                    path,
                    error: String(e),
                }).pipe(Effect.as(null as string | null)),
            ),
        );
        if (text === null) return null;
        const parsed = safeJsonParse<IndexUnhealthyMarker>(text);
        if (!parsed) {
            yield* Effect.logWarning("agent-event-index marker malformed - treating as unknown", { path });
            return null;
        }
        return parsed;
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
                `run \`bun scripts/repair-agent-event-index.ts\` against the ax DB`,
        };
