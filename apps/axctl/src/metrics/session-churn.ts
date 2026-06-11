import { Effect } from "effect";
import { recordLiteral } from "@ax/lib/ids";
import { recordKeyPart } from "@ax/lib/shared/derive-keys";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { surrealDate, surrealString } from "@ax/lib/shared/surql";
import {
    canonicalEditToolName,
    editToolSqlFilter,
    isApplyPatchCall,
    isEditTool,
    toolClassInputOf,
} from "@ax/lib/shared/tool-classes";
import { editDelta } from "../dashboard/loc-query.ts";
import { checkFamilyFromCommand, coerceCheckFamily, commandNormNeedsText } from "../ingest/check-family.ts";
import { applyPatchDelta } from "./session-loc.ts";
import { fetchSessionHealthMap } from "./session-metrics-query.ts";
import { cleanSessionId } from "./util.ts";
import { chunked, numOrZero, sessionRefList, strOrNull } from "./util.ts";

export interface ChurnEvent {
    readonly session: string;
    readonly source: string | null;
    readonly tsMs: number;
    readonly kind: "edit" | "verification_fail" | "verification_pass";
    readonly check: string | null;
    readonly linesAdded: number;
    readonly linesRemoved: number;
}

export interface SessionChurnRow {
    readonly session: string;
    readonly source: string | null;
    readonly taskLabel: string | null;
    readonly landedLinesAdded: number;
    readonly landedLinesRemoved: number;
    readonly editLinesAdded: number;
    readonly editLinesRemoved: number;
    readonly repairLinesAdded: number;
    readonly repairLinesRemoved: number;
    readonly editEvents: number;
    readonly verificationFailures: number;
    readonly verificationPasses: number;
    readonly episodes: number;
    readonly passedEpisodes: number;
    readonly topCheck: string | null;
}

export interface SourceChurnAggregate {
    readonly source: string;
    readonly sessions: number;
    readonly sessionsWithFailures: number;
    readonly landedLinesAdded: number;
    readonly landedLinesRemoved: number;
    readonly editLinesAdded: number;
    readonly editLinesRemoved: number;
    readonly repairLinesAdded: number;
    readonly repairLinesRemoved: number;
    readonly verificationFailures: number;
    readonly episodes: number;
    readonly passedEpisodes: number;
    readonly topCheck: string | null;
}

export interface SessionChurnSummary {
    readonly generatedAt: string;
    readonly filters: {
        readonly since: string | null;
        readonly project: string | null;
        readonly source: string | null;
        readonly limit: number;
    };
    readonly aggregates: SourceChurnAggregate[];
    readonly hotSessions: SessionChurnRow[];
}

export interface FetchSessionChurnInput {
    readonly since: Date | null;
    readonly project?: string | null;
    readonly source?: string | null;
    readonly limit: number;
    readonly generatedAt?: Date | string;
}

export interface ChurnLines {
    readonly added: number;
    readonly removed: number;
}

/** Commit-level landed LOC with every producing session, for aggregate dedupe. */
export interface LandedCommit {
    readonly commit: string;
    readonly sessions: readonly string[];
    readonly added: number;
    readonly removed: number;
}

export interface LandedLoc {
    readonly bySession: ReadonlyMap<string, ChurnLines>;
    readonly commits: readonly LandedCommit[];
}

export interface SessionHealthChurnInput {
    readonly taskLabel?: string | null;
}

export interface ComputeSessionChurnOptions {
    readonly generatedAt?: Date | string;
    readonly since?: Date | string | null;
    readonly project?: string | null;
    readonly source?: string | null;
    readonly limit?: number;
    /**
     * When provided, source aggregates compute landed LOC from these commits
     * (each counted once per source) instead of summing per-session rows -
     * a commit produced by several sessions keeps full per-session credit
     * without inflating the source totals.
     */
    readonly landedCommits?: readonly LandedCommit[];
}

interface IndexedChurnEvent extends ChurnEvent {
    readonly index: number;
}

interface MutableSessionState {
    session: string;
    source: string | null;
    taskLabel: string | null;
    landedLinesAdded: number;
    landedLinesRemoved: number;
    editLinesAdded: number;
    editLinesRemoved: number;
    repairLinesAdded: number;
    repairLinesRemoved: number;
    editEvents: number;
    verificationFailures: number;
    verificationPasses: number;
    episodes: number;
    passedEpisodes: number;
    hasPriorEdit: boolean;
    /** check family -> tsMs of the failure that opened/refreshed the episode */
    openChecks: Map<string, number>;
    checkFailures: Map<string, number>;
}

interface MutableAggregateState {
    source: string;
    sessions: number;
    sessionsWithFailures: number;
    landedLinesAdded: number;
    landedLinesRemoved: number;
    editLinesAdded: number;
    editLinesRemoved: number;
    repairLinesAdded: number;
    repairLinesRemoved: number;
    verificationFailures: number;
    episodes: number;
    passedEpisodes: number;
}

const DEFAULT_LIMIT = 10;
const IN_CHUNK = 500;

/**
 * An open episode whose failure saw no same-family verification event for
 * this long stops attributing edits as repair churn - one uncaptured pass
 * must not taint the rest of the session.
 */
export const EPISODE_EXPIRY_MS = 30 * 60_000;

// Accepts an already-canonical family ("test") or a raw command ("bun test");
// raw commands classify only when the check is in command position.
export const normalizeCheckFamily = (raw: string | null): string | null =>
    coerceCheckFamily(raw);

export const computeSessionChurn = (
    events: readonly ChurnEvent[],
    landedBySession: ReadonlyMap<string, ChurnLines>,
    healthBySession: ReadonlyMap<string, string | null | SessionHealthChurnInput>,
    options: ComputeSessionChurnOptions = {},
): SessionChurnSummary => {
    const sourceFilter = options.source ?? null;
    const limit = Math.max(0, Math.trunc(options.limit ?? DEFAULT_LIMIT));
    const generatedAt = dateishToIso(options.generatedAt ?? new Date());
    const states = new Map<string, MutableSessionState>();
    const normalizedLanded = normalizeLandedMap(landedBySession);
    const normalizedHealth = normalizeHealthMap(healthBySession);

    for (const session of normalizedLanded.keys()) {
        getState(states, session, null, normalizedLanded, normalizedHealth);
    }
    for (const session of normalizedHealth.keys()) {
        getState(states, session, null, normalizedLanded, normalizedHealth);
    }

    const sorted = events
        .map((event, index): IndexedChurnEvent => ({ ...event, session: normalizeSessionKey(event.session), index }))
        .filter((event) => sourceFilter === null || event.source === sourceFilter)
        .sort((a, b) => a.session.localeCompare(b.session) || a.tsMs - b.tsMs || a.index - b.index);

    for (const event of sorted) {
        const state = getState(states, event.session, event.source, normalizedLanded, normalizedHealth);
        if (state.source === null && event.source !== null) state.source = event.source;
        expireOpenChecks(state, event.tsMs);

        if (event.kind === "edit") {
            state.editEvents += 1;
            state.editLinesAdded += nonNegative(event.linesAdded);
            state.editLinesRemoved += nonNegative(event.linesRemoved);
            state.hasPriorEdit = true;

            if (state.openChecks.size > 0) {
                state.repairLinesAdded += nonNegative(event.linesAdded);
                state.repairLinesRemoved += nonNegative(event.linesRemoved);
            }
            continue;
        }

        const check = normalizeCheckFamily(event.check);
        if (check === null) continue;

        if (event.kind === "verification_fail") {
            state.verificationFailures += 1;
            increment(state.checkFailures, check, 1);
            if (state.hasPriorEdit) {
                if (!state.openChecks.has(check)) state.episodes += 1;
                state.openChecks.set(check, event.tsMs);
            }
            continue;
        }

        state.verificationPasses += 1;
        if (state.openChecks.delete(check)) {
            state.passedEpisodes += 1;
        }
    }

    const rowsWithChecks = [...states.values()]
        .map((state) => ({ row: freezeRow(state), checkFailures: state.checkFailures }))
        .filter(({ row }) => hasVerificationSignal(row))
        .filter(({ row }) => sourceFilter === null || row.source === sourceFilter);

    const aggregates = buildAggregates(rowsWithChecks, options.landedCommits ?? null);
    const hotSessions = rowsWithChecks
        .map(({ row }) => row)
        .sort(compareHotSessions)
        .slice(0, limit);

    return {
        generatedAt,
        filters: {
            since: dateishToIsoOrNull(options.since ?? null),
            project: options.project ?? null,
            source: sourceFilter,
            limit,
        },
        aggregates,
        hotSessions,
    };
};

export const fetchSessionChurnSummary = (
    input: FetchSessionChurnInput,
): Effect.Effect<SessionChurnSummary, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 1000);
        const project = input.project ?? null;
        const source = input.source ?? null;
        const clauses: string[] = [];
        if (input.since) clauses.push(`session.started_at >= ${surrealDate(input.since)}`);
        if (project !== null) {
            const projectSql = surrealString(project);
            clauses.push(`(session.project = ${projectSql} OR session.cwd = ${projectSql})`);
        }
        if (source !== null) clauses.push(`session.source = ${surrealString(source)}`);
        const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
        const baseRows = (yield* db.query<[Array<Record<string, unknown>>]>(`
SELECT type::string(session) AS session, session.source AS source, session.started_at AS started_at
FROM session_metrics
${where}
ORDER BY session.started_at DESC;`))?.[0] ?? [];

        const sessionIds = uniqueCleanSessionIds(baseRows.map((row) => String(row.session ?? "")));
        const sourceBySession = new Map<string, string | null>();
        for (const row of baseRows) {
            const session = cleanSessionId(String(row.session ?? ""));
            if (session.length === 0) continue;
            sourceBySession.set(session, strOrNull(row.source));
        }
        const options = churnOptions(input, project, source, limit);

        if (sessionIds.length === 0) {
            return computeSessionChurn([], new Map(), new Map(), options);
        }

        const [health, landed, edits, commandEvents, hookEvents] = yield* Effect.all([
            fetchSessionHealthMap(sessionIds),
            fetchLandedLocBySession(sessionIds),
            fetchEditEvents(sessionIds, sourceBySession),
            fetchCommandOutcomeEvents(sessionIds, sourceBySession),
            fetchHookEvents(sessionIds, sourceBySession),
        ], { concurrency: 5 });

        return computeSessionChurn([...edits, ...commandEvents, ...hookEvents], landed.bySession, health, {
            ...options,
            landedCommits: landed.commits,
        });
    });

const fetchLandedLocBySession = (
    sessionIds: readonly string[],
): Effect.Effect<LandedLoc, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const out = new Map<string, ChurnLines>();
        const commitTotals = new Map<string, { added: number; removed: number }>();
        if (sessionIds.length === 0) return { bySession: out, commits: [] };

        const producedRows = (yield* Effect.all(
            chunked(sessionIds, IN_CHUNK).map((ids) =>
                db.query<[Array<Record<string, unknown>>]>(
                    `SELECT type::string(in) AS session, type::string(out) AS commit`
                    + ` FROM produced WHERE in IN [${sessionRefList(ids)}];`,
                ),
            ),
            { concurrency: 4 },
        )).flatMap((batch) => batch?.[0] ?? []);

        const sessionsByCommit = new Map<string, Set<string>>();
        for (const row of producedRows) {
            const session = cleanSessionId(String(row.session ?? ""));
            const commit = String(row.commit ?? "");
            if (session.length === 0 || commit.length === 0) continue;
            let sessions = sessionsByCommit.get(commit);
            if (sessions === undefined) {
                sessions = new Set();
                sessionsByCommit.set(commit, sessions);
            }
            sessions.add(session);
        }
        if (sessionsByCommit.size === 0) return { bySession: out, commits: [] };

        const commitIds = [...sessionsByCommit.keys()];
        const touchedRows = (yield* Effect.all(
            chunked(commitIds, IN_CHUNK).map((ids) =>
                db.query<[Array<Record<string, unknown>>]>(
                    `SELECT type::string(in) AS commit, type::string(out) AS file, out.path AS path, old_path, new_path, additions, deletions`
                    + ` FROM touched WHERE in IN [${recordRefList("commit", ids)}];`,
                ),
            ),
            { concurrency: 4 },
        )).flatMap((batch) => batch?.[0] ?? []);

        const seenTouched = new Set<string>();
        for (const row of touchedRows) {
            const commit = String(row.commit ?? "");
            const sessions = sessionsByCommit.get(commit);
            if (sessions === undefined) continue;

            const identity = touchedIdentity(row);
            if (identity !== null) {
                const key = `${commit}:${identity}`;
                if (seenTouched.has(key)) continue;
                seenTouched.add(key);
            }

            const added = numOrZero(row.additions);
            const removed = numOrZero(row.deletions);
            const commitTotal = commitTotals.get(commit) ?? { added: 0, removed: 0 };
            commitTotal.added += added;
            commitTotal.removed += removed;
            commitTotals.set(commit, commitTotal);
            for (const session of sessions) {
                const cur = out.get(session) ?? { added: 0, removed: 0 };
                out.set(session, {
                    added: cur.added + added,
                    removed: cur.removed + removed,
                });
            }
        }

        const commits: LandedCommit[] = [...commitTotals.entries()].map(([commit, lines]) => ({
            commit,
            sessions: [...(sessionsByCommit.get(commit) ?? [])],
            added: lines.added,
            removed: lines.removed,
        }));
        return { bySession: out, commits };
    });

const fetchEditEvents = (
    sessionIds: readonly string[],
    sourceBySession: ReadonlyMap<string, string | null>,
): Effect.Effect<ChurnEvent[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        if (sessionIds.length === 0) return [];
        const rows = (yield* Effect.all(
            chunked(sessionIds, IN_CHUNK).map((ids) =>
                db.query<[Array<Record<string, unknown>>]>(
                    `SELECT type::string(session) AS session, type::string(ts) AS ts, name, command_norm, input_json`
                    + ` FROM tool_call WHERE session IN [${sessionRefList(ids)}] AND ${editToolSqlFilter} ORDER BY ts ASC;`,
                ),
            ),
            { concurrency: 4 },
        )).flatMap((batch) => batch?.[0] ?? []);

        const events: ChurnEvent[] = [];
        for (const row of rows) {
            const call = toolClassInputOf(row);
            if (!isEditTool(call)) continue;
            const session = cleanSessionId(String(row.session ?? ""));
            const tsMs = msOrNull(row.ts);
            if (session.length === 0 || tsMs === null) continue;
            const inputJson = strOrNull(row.input_json);
            const delta = isApplyPatchCall(call)
                ? applyPatchDelta(inputJson)
                : editDelta(canonicalEditToolName(call.name), inputJson);
            events.push({
                session,
                source: sourceBySession.get(session) ?? null,
                tsMs,
                kind: "edit",
                check: null,
                linesAdded: delta.added,
                linesRemoved: delta.removed,
            });
        }
        return events;
    });

const fetchCommandOutcomeEvents = (
    sessionIds: readonly string[],
    sourceBySession: ReadonlyMap<string, string | null>,
): Effect.Effect<ChurnEvent[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        if (sessionIds.length === 0) return [];
        // Deref-free: command_text lives on tool_call only and is batch-joined
        // below for the few rows whose normalized command is ambiguous.
        const rows = (yield* Effect.all(
            chunked(sessionIds, IN_CHUNK).map((ids) =>
                db.query<[Array<Record<string, unknown>>]>(
                    `SELECT type::string(session) AS session, type::string(ts) AS ts, kind, status, command_norm, type::string(tool_call) AS tool_call_ref`
                    + ` FROM command_outcome WHERE session IN [${sessionRefList(ids)}];`,
                ),
            ),
            { concurrency: 4 },
        )).flatMap((batch) => batch?.[0] ?? []);

        interface PendingOutcome {
            readonly session: string;
            readonly tsMs: number;
            readonly eventKind: "verification_fail" | "verification_pass";
            readonly toolCallKey: string;
        }

        const events: ChurnEvent[] = [];
        const pending: PendingOutcome[] = [];
        const pushEvent = (session: string, tsMs: number, eventKind: PendingOutcome["eventKind"], check: string) => {
            events.push({
                session,
                source: sourceBySession.get(session) ?? null,
                tsMs,
                kind: eventKind,
                check,
                linesAdded: 0,
                linesRemoved: 0,
            });
        };

        for (const row of rows) {
            const session = cleanSessionId(String(row.session ?? ""));
            const tsMs = msOrNull(row.ts);
            const status = strOrNull(row.status);
            const kind = strOrNull(row.kind);
            const eventKind = kind === "expected_feedback" || status === "error"
                ? "verification_fail" as const
                : status === "ok"
                    ? "verification_pass" as const
                    : null;
            if (eventKind === null || session.length === 0 || tsMs === null) continue;

            const norm = strOrNull(row.command_norm);
            const check = checkFamilyFromCommand(norm);
            if (check !== null) {
                pushEvent(session, tsMs, eventKind, check);
                continue;
            }
            if (!commandNormNeedsText(norm)) continue;
            const toolCallKey = recordKeyPart(strOrNull(row.tool_call_ref), "tool_call");
            if (toolCallKey === null || toolCallKey.length === 0) continue;
            pending.push({ session, tsMs, eventKind, toolCallKey });
        }

        if (pending.length > 0) {
            const keys = [...new Set(pending.map((item) => item.toolCallKey))];
            const textRows = (yield* Effect.all(
                chunked(keys, IN_CHUNK).map((ids) =>
                    db.query<[Array<Record<string, unknown>>]>(
                        `SELECT type::string(id) AS id, command_text FROM tool_call WHERE id IN [${recordRefList("tool_call", ids)}];`,
                    ),
                ),
                { concurrency: 4 },
            )).flatMap((batch) => batch?.[0] ?? []);

            const textByKey = new Map<string, string | null>();
            for (const row of textRows) {
                const key = recordKeyPart(strOrNull(row.id), "tool_call");
                if (key !== null && key.length > 0) textByKey.set(key, strOrNull(row.command_text));
            }
            for (const item of pending) {
                const check = checkFamilyFromCommand(textByKey.get(item.toolCallKey) ?? null);
                if (check === null) continue;
                pushEvent(item.session, item.tsMs, item.eventKind, check);
            }
        }
        return events;
    });

const fetchHookEvents = (
    sessionIds: readonly string[],
    sourceBySession: ReadonlyMap<string, string | null>,
): Effect.Effect<ChurnEvent[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        if (sessionIds.length === 0) return [];
        const rows = (yield* Effect.all(
            chunked(sessionIds, IN_CHUNK).map((ids) =>
                db.query<[Array<Record<string, unknown>>]>(
                    `SELECT type::string(session) AS session, type::string(ts) AS ts, provider_status, effect, exit_code, command, hook_name`
                    + ` FROM hook_command_invocation WHERE session IN [${sessionRefList(ids)}] ORDER BY ts ASC;`,
                ),
            ),
            { concurrency: 4 },
        )).flatMap((batch) => batch?.[0] ?? []);

        const events: ChurnEvent[] = [];
        for (const row of rows) {
            const session = cleanSessionId(String(row.session ?? ""));
            const tsMs = msOrNull(row.ts);
            // Classify by the hook's command only - hook_name keywords (e.g.
            // "bun-test-blocking") must not register as verification events.
            const check = normalizedCheckFrom(row.command);
            if (session.length === 0 || tsMs === null || check === null) continue;
            const providerStatus = strOrNull(row.provider_status);
            const effect = strOrNull(row.effect);
            const exitCode = exitCodeOf(row.exit_code);
            const eventKind = providerStatus === "blocking_error" || effect === "blocked" || (exitCode !== null && exitCode !== 0)
                ? "verification_fail"
                : providerStatus === "success" && effect !== "blocked" && (exitCode === null || exitCode === 0)
                    ? "verification_pass"
                    : null;
            if (eventKind === null) continue;
            events.push({
                session,
                source: sourceBySession.get(session) ?? null,
                tsMs,
                kind: eventKind,
                check,
                linesAdded: 0,
                linesRemoved: 0,
            });
        }
        return events;
    });

export const formatSessionChurnSummary = (summary: SessionChurnSummary): string => {
    if (summary.aggregates.length === 0) {
        return "no verification churn rows matched (run `ax ingest`, or loosen --since/--source/--here).";
    }

    const sourceRows = summary.aggregates.map((row) => [
        row.source,
        String(row.sessions),
        String(row.sessionsWithFailures),
        String(row.verificationFailures),
        String(row.episodes),
        String(row.passedEpisodes),
        loc(row.landedLinesAdded, row.landedLinesRemoved),
        loc(row.editLinesAdded, row.editLinesRemoved),
        loc(row.repairLinesAdded, row.repairLinesRemoved),
        row.topCheck ?? "-",
    ]);

    const sessionRows = summary.hotSessions.map((row) => [
        truncate(row.session, 20),
        row.source ?? "unknown",
        String(row.verificationFailures),
        String(row.episodes),
        String(row.passedEpisodes),
        loc(row.landedLinesAdded, row.landedLinesRemoved),
        loc(row.editLinesAdded, row.editLinesRemoved),
        loc(row.repairLinesAdded, row.repairLinesRemoved),
        row.topCheck ?? "-",
        row.taskLabel ?? "-",
    ]);

    return [
        "verification churn by source",
        table(["source", "sess", "fail-sess", "fails", "episodes", "pass", "landed", "edits", "repair", "top"], sourceRows),
        "",
        "hot sessions",
        table(["session", "source", "fails", "episodes", "pass", "landed", "edits", "repair", "top", "task"], sessionRows),
    ].join("\n");
};

const getState = (
    states: Map<string, MutableSessionState>,
    session: string,
    source: string | null,
    landedBySession: ReadonlyMap<string, ChurnLines>,
    healthBySession: ReadonlyMap<string, string | null | SessionHealthChurnInput>,
): MutableSessionState => {
    const existing = states.get(session);
    if (existing !== undefined) return existing;

    const landed = landedBySession.get(session);
    const state: MutableSessionState = {
        session,
        source,
        taskLabel: taskLabelOf(healthBySession.get(session)),
        landedLinesAdded: landed?.added ?? 0,
        landedLinesRemoved: landed?.removed ?? 0,
        editLinesAdded: 0,
        editLinesRemoved: 0,
        repairLinesAdded: 0,
        repairLinesRemoved: 0,
        editEvents: 0,
        verificationFailures: 0,
        verificationPasses: 0,
        episodes: 0,
        passedEpisodes: 0,
        hasPriorEdit: false,
        openChecks: new Map(),
        checkFailures: new Map(),
    };
    states.set(session, state);
    return state;
};

const normalizeLandedMap = (input: ReadonlyMap<string, ChurnLines>): Map<string, ChurnLines> => {
    const out = new Map<string, ChurnLines>();
    for (const [session, lines] of input) {
        const key = normalizeSessionKey(session);
        const cur = out.get(key) ?? { added: 0, removed: 0 };
        out.set(key, {
            added: cur.added + nonNegative(lines.added),
            removed: cur.removed + nonNegative(lines.removed),
        });
    }
    return out;
};

const normalizeHealthMap = (
    input: ReadonlyMap<string, string | null | SessionHealthChurnInput>,
): Map<string, string | null | SessionHealthChurnInput> => {
    const out = new Map<string, string | null | SessionHealthChurnInput>();
    for (const [session, health] of input) {
        const key = normalizeSessionKey(session);
        const existing = out.get(key);
        if (existing === undefined || taskLabelOf(existing) === null) {
            out.set(key, health);
        }
    }
    return out;
};

const normalizeSessionKey = (session: string): string => cleanSessionId(session);

const expireOpenChecks = (state: MutableSessionState, tsMs: number): void => {
    for (const [check, openedAt] of state.openChecks) {
        if (tsMs - openedAt > EPISODE_EXPIRY_MS) state.openChecks.delete(check);
    }
};

const hasVerificationSignal = (row: SessionChurnRow): boolean =>
    row.verificationFailures > 0
    || row.episodes > 0
    || row.repairLinesAdded > 0
    || row.repairLinesRemoved > 0;

const freezeRow = (state: MutableSessionState): SessionChurnRow => ({
    session: state.session,
    source: state.source,
    taskLabel: state.taskLabel,
    landedLinesAdded: state.landedLinesAdded,
    landedLinesRemoved: state.landedLinesRemoved,
    editLinesAdded: state.editLinesAdded,
    editLinesRemoved: state.editLinesRemoved,
    repairLinesAdded: state.repairLinesAdded,
    repairLinesRemoved: state.repairLinesRemoved,
    editEvents: state.editEvents,
    verificationFailures: state.verificationFailures,
    verificationPasses: state.verificationPasses,
    episodes: state.episodes,
    passedEpisodes: state.passedEpisodes,
    topCheck: topCheck(state.checkFailures),
});

const buildAggregates = (
    rows: Array<{ readonly row: SessionChurnRow; readonly checkFailures: ReadonlyMap<string, number> }>,
    landedCommits: readonly LandedCommit[] | null,
): SourceChurnAggregate[] => {
    const aggregates = new Map<string, {
        row: MutableAggregateState;
        checkFailures: Map<string, number>;
    }>();

    for (const { row, checkFailures } of rows) {
        const source = row.source ?? "unknown";
        let aggregate = aggregates.get(source);
        if (aggregate === undefined) {
            aggregate = {
                row: {
                    source,
                    sessions: 0,
                    sessionsWithFailures: 0,
                    landedLinesAdded: 0,
                    landedLinesRemoved: 0,
                    editLinesAdded: 0,
                    editLinesRemoved: 0,
                    repairLinesAdded: 0,
                    repairLinesRemoved: 0,
                    verificationFailures: 0,
                    episodes: 0,
                    passedEpisodes: 0,
                },
                checkFailures: new Map(),
            };
            aggregates.set(source, aggregate);
        }

        aggregate.row.sessions += 1;
        aggregate.row.sessionsWithFailures += row.verificationFailures > 0 ? 1 : 0;
        if (landedCommits === null) {
            aggregate.row.landedLinesAdded += row.landedLinesAdded;
            aggregate.row.landedLinesRemoved += row.landedLinesRemoved;
        }
        aggregate.row.editLinesAdded += row.editLinesAdded;
        aggregate.row.editLinesRemoved += row.editLinesRemoved;
        aggregate.row.repairLinesAdded += row.repairLinesAdded;
        aggregate.row.repairLinesRemoved += row.repairLinesRemoved;
        aggregate.row.verificationFailures += row.verificationFailures;
        aggregate.row.episodes += row.episodes;
        aggregate.row.passedEpisodes += row.passedEpisodes;
        for (const [check, count] of checkFailures) {
            increment(aggregate.checkFailures, check, count);
        }
    }

    if (landedCommits !== null) {
        const sourceBySession = new Map(rows.map(({ row }) => [row.session, row.source ?? "unknown"]));
        for (const commit of landedCommits) {
            const sources = new Set<string>();
            for (const session of commit.sessions) {
                const source = sourceBySession.get(normalizeSessionKey(session));
                if (source !== undefined) sources.add(source);
            }
            for (const source of sources) {
                const aggregate = aggregates.get(source);
                if (aggregate === undefined) continue;
                aggregate.row.landedLinesAdded += nonNegative(commit.added);
                aggregate.row.landedLinesRemoved += nonNegative(commit.removed);
            }
        }
    }

    return [...aggregates.values()]
        .map(({ row, checkFailures }) => ({ ...row, topCheck: topCheck(checkFailures) }))
        .sort((a, b) => b.verificationFailures - a.verificationFailures || b.repairLinesAdded + b.repairLinesRemoved - (a.repairLinesAdded + a.repairLinesRemoved) || a.source.localeCompare(b.source));
};

const compareHotSessions = (a: SessionChurnRow, b: SessionChurnRow): number =>
    b.verificationFailures - a.verificationFailures
    || (b.repairLinesAdded + b.repairLinesRemoved) - (a.repairLinesAdded + a.repairLinesRemoved)
    || b.episodes - a.episodes
    || a.session.localeCompare(b.session);

const topCheck = (counts: ReadonlyMap<string, number>): string | null => {
    const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return top?.[0] ?? null;
};

const increment = (counts: Map<string, number>, key: string, amount: number): void => {
    counts.set(key, (counts.get(key) ?? 0) + amount);
};

const uniqueCleanSessionIds = (ids: readonly string[]): string[] =>
    [...new Set(ids.map((id) => cleanSessionId(id)).filter((id) => id.length > 0))];

const churnOptions = (
    input: FetchSessionChurnInput,
    project: string | null,
    source: string | null,
    limit: number,
): ComputeSessionChurnOptions => ({
    since: input.since,
    project,
    source,
    limit,
    ...(input.generatedAt !== undefined ? { generatedAt: input.generatedAt } : {}),
});

const recordRefList = (table: string, ids: readonly string[]): string =>
    ids
        .map((id) => recordKeyPart(id, table))
        .filter((id): id is string => id !== null && id.length > 0)
        .map((id) => recordLiteral(table, id))
        .join(", ");

const touchedIdentity = (row: Record<string, unknown>): string | null => {
    const file = strOrNull(row.file);
    if (file !== null) return file;
    const path = strOrNull(row.path) ?? strOrNull(row.new_path) ?? strOrNull(row.old_path);
    return path;
};

const normalizedCheckFrom = (...values: readonly unknown[]): string | null => {
    for (const value of values) {
        const check = normalizeCheckFamily(strOrNull(value));
        if (check !== null) return check;
    }
    return null;
};

const exitCodeOf = (value: unknown): number | null => {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
};

const msOrNull = (value: unknown): number | null => {
    if (value instanceof Date) return value.getTime();
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "string" || value.length === 0) return null;
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
};

const taskLabelOf = (input: string | null | SessionHealthChurnInput | undefined): string | null => {
    if (typeof input === "string") return input;
    if (input === null || input === undefined) return null;
    return input.taskLabel ?? null;
};

const nonNegative = (n: number): number => Number.isFinite(n) && n > 0 ? n : 0;

const dateishToIso = (value: Date | string): string =>
    value instanceof Date ? value.toISOString() : value;

const dateishToIsoOrNull = (value: Date | string | null): string | null =>
    value === null ? null : dateishToIso(value);

const loc = (added: number, removed: number): string => `+${added}/-${removed}`;

const truncate = (text: string, max: number): string =>
    text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;

const table = (header: readonly string[], rows: readonly string[][]): string => {
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));
    const render = (cells: readonly string[]) => cells
        .map((cell, i) => isNumericColumn(header[i] ?? "") ? cell.padStart(widths[i] ?? cell.length) : cell.padEnd(widths[i] ?? cell.length))
        .join("  ")
        .trimEnd();
    return [render(header), ...rows.map(render)].join("\n");
};

const isNumericColumn = (name: string): boolean =>
    ["sess", "fail-sess", "fails", "episodes", "pass"].includes(name);
