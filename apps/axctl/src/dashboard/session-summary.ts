import { Effect, Schema } from "effect";
import { CacheRead, type CacheReadError } from "@ax/lib/duckdb";
import { NumberFromBigIntColumn } from "@ax/lib/duckdb/columns";
import { toBareSessionId } from "@ax/lib/shared/session-id";
import type { SessionSummary } from "@ax/lib/shared/dashboard-types";

// DB-ONLY session summary for the canvas detail card. Deliberately avoids
// `locateTranscript` + the full JSONL read/parse that `fetchSessionInspect`
// does (that path can take 20-60s when it falls back to a filesystem walk).
// Everything the card shows is already in the graph: turn excerpts, tool calls,
// token usage, spawn edges. ~ms per query, run concurrently.

// real first ask: a 'task'-kind user turn (skips AGENTS.md/CLAUDE.md context
// injections that also carry role='user'). Falls back to any user turn.
const FIRST_USER_SQL = `SELECT text_excerpt, seq FROM turn WHERE session = ? AND role = 'user' AND message_kind = 'task' ORDER BY seq ASC LIMIT 1`;
const FIRST_USER_FALLBACK_SQL = `SELECT text_excerpt, seq FROM turn WHERE session = ? AND role = 'user' ORDER BY seq ASC LIMIT 1`;
// session_health.task_label is the boilerplate-filtered, organic-task-detected
// label the canvas already shows - prefer it when present.
const TASK_LABEL_SQL = `SELECT task_label FROM session_health WHERE session = ? LIMIT 1`;
const LAST_ASSISTANT_SQL = `SELECT text_excerpt, seq FROM turn WHERE session = ? AND role = 'assistant' ORDER BY seq DESC LIMIT 1`;
const CORRECTION_SQL = `SELECT text_excerpt, seq FROM turn WHERE session = ? AND intent_kind = 'correction' ORDER BY seq ASC LIMIT 1`;
const TURN_COUNT_SQL = `SELECT count(*) AS n FROM turn WHERE session = ? AND role IN ('user', 'assistant')`;
const TOKENS_SQL = `SELECT model, estimated_tokens, estimated_cost_usd FROM session_token_usage WHERE session = ? LIMIT 1`;
const SUBAGENTS_SQL = `SELECT count(*) AS n FROM spawned WHERE in_id = ?`;
const TOOLS_SQL = `SELECT name, count(*) AS n FROM tool_call WHERE session = ? GROUP BY name`;

const ExcerptRow = Schema.Struct({
    text_excerpt: Schema.NullOr(Schema.String),
    seq: NumberFromBigIntColumn,
});
const LabelRow = Schema.Struct({ task_label: Schema.NullOr(Schema.String) });
const CountRow = Schema.Struct({ n: NumberFromBigIntColumn });
const TokenRow = Schema.Struct({
    model: Schema.NullOr(Schema.String),
    estimated_tokens: NumberFromBigIntColumn,
    estimated_cost_usd: Schema.NullOr(Schema.Number),
});
const ToolRow = Schema.Struct({ name: Schema.String, n: NumberFromBigIntColumn });

const excerpt = (row: typeof ExcerptRow.Type | undefined): string | null => {
    const v = row?.text_excerpt;
    return typeof v === "string" && v.trim().length > 0 ? v.replace(/\s+/g, " ").trim() : null;
};

export const fetchSessionSummary = (
    sessionId: string,
): Effect.Effect<SessionSummary, CacheReadError, CacheRead> =>
    Effect.gen(function* () {
        const bare = toBareSessionId(sessionId);
        const db = yield* CacheRead;
        const [fu, fuFallback, label, la, corr, tc, tok, sub, tools] = yield* Effect.all([
            db.rows(ExcerptRow, FIRST_USER_SQL, [bare]),
            db.rows(ExcerptRow, FIRST_USER_FALLBACK_SQL, [bare]),
            db.rows(LabelRow, TASK_LABEL_SQL, [bare]),
            db.rows(ExcerptRow, LAST_ASSISTANT_SQL, [bare]),
            db.rows(ExcerptRow, CORRECTION_SQL, [bare]),
            db.rows(CountRow, TURN_COUNT_SQL, [bare]),
            db.rows(TokenRow, TOKENS_SQL, [bare]),
            db.rows(CountRow, SUBAGENTS_SQL, [bare]),
            db.rows(ToolRow, TOOLS_SQL, [bare]),
        ], { concurrency: "unbounded" });

        const firstAsk = excerpt(fu[0]) ?? excerpt(fuFallback[0]);
        const taskLabelRaw = label[0]?.task_label;
        const taskLabel = typeof taskLabelRaw === "string" && taskLabelRaw.trim().length > 0
            ? taskLabelRaw.replace(/\s+/g, " ").trim() : null;
        const tokRow = tok[0];
        return {
            session_id: bare,
            task: taskLabel ?? firstAsk,
            first_ask: firstAsk,
            last_assistant: excerpt(la[0]),
            correction: excerpt(corr[0]),
            turns: tc[0]?.n ?? 0,
            tokens: tokRow?.estimated_tokens ?? null,
            cost_usd: tokRow?.estimated_cost_usd ?? null,
            model: tokRow?.model ?? null,
            subagents: sub[0]?.n ?? 0,
            tools: tools
                .map((r) => ({ name: r.name, count: r.n }))
                .filter((t) => t.name.length > 0)
                .sort((a, b) => b.count - a.count),
        };
    });
