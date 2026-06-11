import { cleanSessionId } from "./util.ts";

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

export interface ChurnLines {
    readonly added: number;
    readonly removed: number;
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
    openChecks: Set<string>;
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

export const normalizeCheckFamily = (raw: string | null): string | null => {
    if (raw === null) return null;
    const text = raw.trim().toLowerCase();
    if (text.length === 0) return null;

    if (/\boxlint\b/.test(text) || /\boxc\b/.test(text)) return "oxlint";
    if (/\beslint\b/.test(text)) return "eslint";
    if (/\blint\b/.test(text)) return "lint";
    if (/\b(tsc|typecheck|tsgo)\b/.test(text)) return "typecheck";
    if (/\b(bun\s+test|vitest|jest|playwright|test)\b/.test(text)) return "test";
    if (/\bbuild\b/.test(text)) return "build";
    if (/\bcheck\b/.test(text)) return "check";
    return null;
};

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
    const countedRepairEditKeys = new Set<string>();
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

        if (event.kind === "edit") {
            state.editEvents += 1;
            state.editLinesAdded += nonNegative(event.linesAdded);
            state.editLinesRemoved += nonNegative(event.linesRemoved);
            state.hasPriorEdit = true;

            if (state.openChecks.size > 0) {
                const repairKey = `${event.session}:${event.index}`;
                if (!countedRepairEditKeys.has(repairKey)) {
                    countedRepairEditKeys.add(repairKey);
                    state.repairLinesAdded += nonNegative(event.linesAdded);
                    state.repairLinesRemoved += nonNegative(event.linesRemoved);
                }
            }
            continue;
        }

        const check = normalizeCheckFamily(event.check);
        if (check === null) continue;

        if (event.kind === "verification_fail") {
            state.verificationFailures += 1;
            increment(state.checkFailures, check, 1);
            if (state.hasPriorEdit && !state.openChecks.has(check)) {
                state.openChecks.add(check);
                state.episodes += 1;
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

    const aggregates = buildAggregates(rowsWithChecks);
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
        openChecks: new Set(),
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
        aggregate.row.landedLinesAdded += row.landedLinesAdded;
        aggregate.row.landedLinesRemoved += row.landedLinesRemoved;
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
