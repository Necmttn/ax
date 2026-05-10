import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";

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

export const guidanceNext = (): Effect.Effect<unknown, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const result = yield* db.query(`
SELECT id, guidance, version, text, status, scope, risk, evidence, metrics_before
FROM guidance_version
WHERE status = "proposed"
ORDER BY created_at DESC
LIMIT 5;`);
        return result?.[0] ?? [];
    });

export const sessionSummary = (): Effect.Effect<unknown, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const result = yield* db.query(`
SELECT id, project, cwd, started_at, ended_at,
    array::len((SELECT id FROM tool_call WHERE session = $parent.id)) AS tool_calls,
    array::len((SELECT id FROM tool_call WHERE session = $parent.id AND has_error = true)) AS failures
FROM session
ORDER BY (ended_at ?? started_at) DESC
LIMIT 5;`);
        return result?.[0] ?? [];
    });

export const selfImproveWeekly = (): Effect.Effect<unknown, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const result = yield* db.query(`
SELECT kind, count() AS count, time::max(ts) AS last_seen
FROM friction_event
WHERE ts > time::now() - 7d
GROUP BY kind
ORDER BY count DESC;`);
        return result?.[0] ?? [];
    });
