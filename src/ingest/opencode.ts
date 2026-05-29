import { Effect, Schema } from "effect";
import { BaseStageStats, IngestContext, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";

export const OpenCodeKey = Schema.Literal("opencode");
export type OpenCodeKey = typeof OpenCodeKey.Type;

export interface OpenCodeStats {
    readonly sessions: number;
    readonly turns: number;
    readonly toolCalls: number;
}

export const ingestOpenCode = (): Effect.Effect<OpenCodeStats> =>
    Effect.succeed({
        sessions: 0,
        turns: 0,
        toolCalls: 0,
    });

export class OpenCodeStageStats extends BaseStageStats.extend<OpenCodeStageStats>("OpenCodeStageStats")({
    sessionsIngested: Schema.Number,
    turnsIngested: Schema.Number,
    toolCallsIngested: Schema.Number,
}) {}

export const opencodeStage: StageDef<OpenCodeStageStats> = {
    meta: StageMeta.make({ key: "opencode", deps: ["skills", "commands"], tags: ["ingest"] }),
    run: (_ctx: IngestContext) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const result = yield* ingestOpenCode();
            return OpenCodeStageStats.make({
                durationMs: Date.now() - t0,
                summary: `ingested ${result.sessions} sessions, ${result.turns} turns, ${result.toolCalls} tool calls`,
                sessionsIngested: result.sessions,
                turnsIngested: result.turns,
                toolCallsIngested: result.toolCalls,
            });
        }),
};
