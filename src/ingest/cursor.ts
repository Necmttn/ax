import { Effect, Schema } from "effect";
import { BaseStageStats, IngestContext, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";

export const CursorKey = Schema.Literal("cursor");
export type CursorKey = typeof CursorKey.Type;

export interface CursorStats {
    readonly sessions: number;
    readonly turns: number;
    readonly toolCalls: number;
}

export const ingestCursor = (): Effect.Effect<CursorStats> =>
    Effect.succeed({
        sessions: 0,
        turns: 0,
        toolCalls: 0,
    });

export class CursorStageStats extends BaseStageStats.extend<CursorStageStats>("CursorStageStats")({
    sessionsIngested: Schema.Number,
    turnsIngested: Schema.Number,
    toolCallsIngested: Schema.Number,
}) {}

export const cursorStage: StageDef<CursorStageStats> = {
    meta: StageMeta.make({ key: "cursor", deps: ["skills", "commands"], tags: ["ingest"] }),
    run: (_ctx: IngestContext) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const result = yield* ingestCursor();
            return CursorStageStats.make({
                durationMs: Date.now() - t0,
                summary: `ingested ${result.sessions} sessions, ${result.turns} turns, ${result.toolCalls} tool calls`,
                sessionsIngested: result.sessions,
                turnsIngested: result.turns,
                toolCallsIngested: result.toolCalls,
            });
        }),
};
