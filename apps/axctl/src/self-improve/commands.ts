import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { buildGuidanceWriteStatements, guidanceFromSignal } from "./guidance.ts";
import { deriveSignalsForSelfImprove, type SignalInput } from "./signals.ts";

export type SelfImproveCommand =
    | { readonly command: "guidance-next"; readonly json: boolean }
    | { readonly command: "session-summary"; readonly json: boolean }
    | { readonly command: "weekly"; readonly json: boolean };

export function parseSelfImproveArgs(root: string, args: string[]): SelfImproveCommand {
    const json = args.includes("--json");
    if (root === "guidance" && args[0] === "next") return { command: "guidance-next", json };
    if (root === "session" && args[0] === "summary") return { command: "session-summary", json };
    if (root === "self-improve" && args[0] === "weekly") return { command: "weekly", json };
    throw new Error(`unknown self-improve command: ${root} ${args.join(" ")}`);
}

export function guidanceNextSql(): string {
    return `
SELECT id, guidance, version, text, status, scope, risk, evidence, metrics_before
    , created_at
FROM guidance_version
WHERE status = "proposed"
ORDER BY created_at DESC
LIMIT 5;`;
}

export const guidanceNext = (): Effect.Effect<unknown, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const result = yield* db.query(guidanceNextSql());
        return result?.[0] ?? [];
    });

export function sessionSummarySql(): string {
    return `
SELECT id, project, cwd, started_at, ended_at,
    (ended_at ?? started_at) AS last_seen_at,
    array::len((SELECT id FROM tool_call WHERE session = $parent.id)) AS tool_calls,
    array::len((SELECT id FROM tool_call WHERE session = $parent.id AND has_error = true)) AS failures
FROM session
ORDER BY last_seen_at DESC
LIMIT 5;`;
}

export const sessionSummary = (): Effect.Effect<unknown, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const result = yield* db.query(sessionSummarySql());
        return result?.[0] ?? [];
    });

export function weeklyEvidenceSql(days: number): string {
    return `
SELECT id, project, started_at AS startedAt FROM session WHERE started_at > time::now() - ${days}d;
SELECT session AS sessionId, command_norm AS commandNorm, has_error AS hasError, ts FROM tool_call WHERE ts > time::now() - ${days}d;
SELECT session AS sessionId, status, ts FROM plan_snapshot WHERE ts > time::now() - ${days}d;`;
}

export const deriveWeeklyGuidance = (days = 7): Effect.Effect<unknown, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const result = yield* db.query(weeklyEvidenceSql(days));
        const input: SignalInput = {
            sessions: (result?.[0] ?? []) as SignalInput["sessions"],
            toolCalls: (result?.[1] ?? []) as SignalInput["toolCalls"],
            planSnapshots: (result?.[2] ?? []) as SignalInput["planSnapshots"],
        };
        const guidance = deriveSignalsForSelfImprove(input).map(guidanceFromSignal);
        for (const draft of guidance) {
            yield* db.query(buildGuidanceWriteStatements(draft).join("\n"));
        }
        return { guidanceCount: guidance.length, guidance };
    });

export const selfImproveWeekly = (): Effect.Effect<unknown, DbError, SurrealClient> =>
    deriveWeeklyGuidance(7);
