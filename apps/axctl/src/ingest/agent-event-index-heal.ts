/**
 * Historical doctor marker for the old SurrealDB agent-event index repair.
 * DuckDB applies this index from schema.duckdb.sql when the live cache opens.
 */
import { Effect, FileSystem } from "effect";
import { skipNotFound } from "@ax/lib/shared/fs-error";
import { safeJsonParse } from "@ax/lib/shared/safe-json";

export const AGENT_EVENT_SEQ_INDEX = "agent_event_session_seq";

export const isAgentEventSeqDuplicateError = (error: unknown): boolean =>
    error instanceof Error && error.message.includes(AGENT_EVENT_SEQ_INDEX);

export const extractAgentSessionId = (message: string): string | null => {
    const match = message.match(/agent_session:[`⟨]?([A-Za-z0-9_.:-]+?)[`⟩\]',\s]/);
    return match?.[1] ?? null;
};

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

export const AGENT_EVENT_SEQ_REPAIR_HINT =
    `${AGENT_EVENT_SEQ_INDEX} is part of the DuckDB schema and rebuilds with the live cache`;

export interface IndexUnhealthyMarker {
    readonly session_id: string | null;
    readonly message: string;
    readonly at: string;
}

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
        const path = agentEventIndexMarkerPath(dataDir);
        const text = yield* fs.readFileString(path).pipe(
            skipNotFound(null as string | null),
            Effect.catchTag("PlatformError", (error) =>
                Effect.logWarning("agent-event-index marker present but unreadable", {
                    path,
                    error: String(error),
                }).pipe(Effect.as(null as string | null)),
            ),
        );
        if (text === null) return null;
        const parsed = safeJsonParse<IndexUnhealthyMarker>(text);
        if (parsed) return parsed;
        yield* Effect.logWarning("agent-event-index marker malformed - treating as unknown", { path });
        return null;
    });

export const agentEventIndexDoctorCheck = (
    marker: IndexUnhealthyMarker | null,
): { name: string; ok: boolean; detail: string } =>
    marker === null
        ? { name: "agent-event-index", ok: true, detail: `${AGENT_EVENT_SEQ_INDEX} healthy` }
        : {
            name: "agent-event-index",
            ok: false,
            detail: `${AGENT_EVENT_SEQ_INDEX} has a historical unhealthy marker from ${marker.at}; run ax ingest --reset`,
        };
