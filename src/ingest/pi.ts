import { Effect, Schema } from "effect";
import { BaseStageStats, IngestContext, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";

export const PiKey = Schema.Literal("pi");
export type PiKey = typeof PiKey.Type;

export interface PiStats {
    readonly sessions: number;
    readonly turns: number;
    readonly toolCalls: number;
}

export const ingestPi = (): Effect.Effect<PiStats> =>
    Effect.succeed({
        sessions: 0,
        turns: 0,
        toolCalls: 0,
    });

export class PiStageStats extends BaseStageStats.extend<PiStageStats>("PiStageStats")({
    sessionsIngested: Schema.Number,
    turnsIngested: Schema.Number,
    toolCallsIngested: Schema.Number,
}) {}

export const piStage: StageDef<PiStageStats> = {
    meta: StageMeta.make({ key: "pi", deps: ["skills", "commands"], tags: ["ingest"] }),
    run: (_ctx: IngestContext) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const result = yield* ingestPi();
            return PiStageStats.make({
                durationMs: Date.now() - t0,
                summary: `ingested ${result.sessions} sessions, ${result.turns} turns, ${result.toolCalls} tool calls`,
                sessionsIngested: result.sessions,
                turnsIngested: result.turns,
                toolCallsIngested: result.toolCalls,
            });
        }),
};
