import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { interpolateRid } from "@ax/lib/shared/graph-query";
import { toBareSessionId } from "@ax/lib/shared/session-id";
import type { SessionSummary } from "@ax/lib/shared/dashboard-types";
import { numberOrNull, numberOrZero } from "@ax/lib/shared/surreal";

// DB-ONLY session summary for the canvas detail card. Deliberately avoids
// `locateTranscript` + the full JSONL read/parse that `fetchSessionInspect`
// does (that path can take 20-60s when it falls back to a filesystem walk).
// Everything the card shows is already in the graph: turn excerpts, tool calls,
// token usage, spawn edges. ~ms per query, run concurrently.

// real first ask: a 'task'-kind user turn (skips AGENTS.md/CLAUDE.md context
// injections that also carry role='user'). Falls back to any user turn.
const FIRST_USER_SQL = `SELECT text_excerpt, seq FROM turn WHERE session = $sid AND role = "user" AND message_kind = "task" ORDER BY seq ASC LIMIT 1;`;
const FIRST_USER_FALLBACK_SQL = `SELECT text_excerpt, seq FROM turn WHERE session = $sid AND role = "user" ORDER BY seq ASC LIMIT 1;`;
// session_health.task_label is the boilerplate-filtered, organic-task-detected
// label the canvas already shows - prefer it when present.
const TASK_LABEL_SQL = `SELECT task_label FROM session_health WHERE session = $sid LIMIT 1;`;
const LAST_ASSISTANT_SQL = `SELECT text_excerpt, seq FROM turn WHERE session = $sid AND role = "assistant" ORDER BY seq DESC LIMIT 1;`;
const CORRECTION_SQL = `SELECT text_excerpt, seq FROM turn WHERE session = $sid AND intent_kind = "correction" ORDER BY seq ASC LIMIT 1;`;
const TURN_COUNT_SQL = `SELECT count() AS n FROM turn WHERE session = $sid AND role IN ['user', 'assistant'] GROUP ALL;`;
const TOKENS_SQL = `SELECT model, estimated_tokens, estimated_cost_usd FROM session_token_usage WHERE session = $sid LIMIT 1;`;
const SUBAGENTS_SQL = `SELECT count() AS n FROM spawned WHERE in = $sid GROUP ALL;`;
const TOOLS_SQL = `SELECT name, count() AS n FROM tool_call WHERE session = $sid GROUP BY name;`;

type Rows = Array<Record<string, unknown>>;
const first = (r: [Rows] | undefined): Record<string, unknown> | undefined => r?.[0]?.[0];
const excerpt = (r: [Rows] | undefined): string | null => {
    const v = first(r)?.text_excerpt;
    return typeof v === "string" && v.trim().length > 0 ? v.replace(/\s+/g, " ").trim() : null;
};
// Deprecated local aliases → canonical helpers from @ax/lib/shared/surreal.
const numOrNull = numberOrNull;
const intOf = (r: [Rows] | undefined): number => numberOrZero(first(r)?.n);

export const fetchSessionSummary = (
    sessionId: string,
): Effect.Effect<SessionSummary, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const bare = toBareSessionId(sessionId);
        const db = yield* SurrealClient;
        const run = (sql: string) => db.query<[Rows]>(interpolateRid(sql, bare), {});
        const [fu, fuFallback, label, la, corr, tc, tok, sub, tools] = yield* Effect.all([
            run(FIRST_USER_SQL),
            run(FIRST_USER_FALLBACK_SQL),
            run(TASK_LABEL_SQL),
            run(LAST_ASSISTANT_SQL),
            run(CORRECTION_SQL),
            run(TURN_COUNT_SQL),
            run(TOKENS_SQL),
            run(SUBAGENTS_SQL),
            run(TOOLS_SQL),
        ], { concurrency: "unbounded" });

        const firstAsk = excerpt(fu) ?? excerpt(fuFallback);
        const taskLabelRaw = first(label)?.task_label;
        const taskLabel = typeof taskLabelRaw === "string" && taskLabelRaw.trim().length > 0
            ? taskLabelRaw.replace(/\s+/g, " ").trim() : null;
        const tokRow = first(tok);
        return {
            session_id: bare,
            task: taskLabel ?? firstAsk,
            first_ask: firstAsk,
            last_assistant: excerpt(la),
            correction: excerpt(corr),
            turns: intOf(tc),
            tokens: numOrNull(tokRow?.estimated_tokens),
            cost_usd: numOrNull(tokRow?.estimated_cost_usd),
            model: typeof tokRow?.model === "string" ? tokRow.model : null,
            subagents: intOf(sub),
            tools: (tools?.[0] ?? [])
                .map((r) => ({ name: String(r.name ?? ""), count: Number(r.n ?? 0) }))
                .filter((t) => t.name.length > 0)
                .sort((a, b) => b.count - a.count),
        };
    });
