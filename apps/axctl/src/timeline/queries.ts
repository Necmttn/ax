/**
 * Session-scoped SQL + row mappers for timeline extraction. Every query is
 * bounded by the session record ref so it stays in the session indexes. Mappers
 * turn raw SurrealDB records into clean typed rows so `derive.ts` can stay pure
 * (no SurrealDB shapes, fully unit-testable with plain fixtures).
 */
import { isRecord, stringField, dateField } from "@ax/lib/shared/row-fields";
import { toBareSessionId } from "@ax/lib/shared/session-id";

/** `a13f9192-…` -> `session:⟨a13f9192-…⟩` (validated record ref). */
export function sessionRef(sessionId: string): string {
    return `session:⟨${toBareSessionId(sessionId)}⟩`;
}

const numField = (row: Record<string, unknown>, key: string): number | null => {
    const v = row[key];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
};
const boolField = (row: Record<string, unknown>, key: string): boolean =>
    row[key] === true;
const seqField = (row: Record<string, unknown>, key: string): number | null =>
    numField(row, key);

// --- highlight inputs ------------------------------------------------------

export interface HealthRow {
    readonly turns: number;
    readonly user_turns: number;
    readonly assistant_turns: number;
    readonly tool_calls: number;
    readonly tool_errors: number;
    readonly user_corrections: number;
    readonly interruptions: number;
    readonly estimated_tokens: number | null;
}
export const healthSql = (ref: string): string =>
    `SELECT turns, user_turns, assistant_turns, tool_calls, tool_errors, user_corrections, interruptions, estimated_tokens FROM session_health WHERE session = ${ref} LIMIT 1;`;
export const mapHealth = (raw: unknown): HealthRow | null => {
    if (!isRecord(raw)) return null;
    return {
        turns: numField(raw, "turns") ?? 0,
        user_turns: numField(raw, "user_turns") ?? 0,
        assistant_turns: numField(raw, "assistant_turns") ?? 0,
        tool_calls: numField(raw, "tool_calls") ?? 0,
        tool_errors: numField(raw, "tool_errors") ?? 0,
        user_corrections: numField(raw, "user_corrections") ?? 0,
        interruptions: numField(raw, "interruptions") ?? 0,
        estimated_tokens: numField(raw, "estimated_tokens"),
    };
};

export interface OverviewRow {
    readonly source: string | null;
    readonly model: string | null;
    readonly project: string | null;
    readonly cwd: string | null;
    readonly started_at: string | null;
    readonly ended_at: string | null;
}
export const overviewSql = (ref: string): string =>
    `SELECT source, model, project, cwd, started_at, ended_at FROM ${ref};`;
export const mapOverview = (raw: unknown): OverviewRow | null => {
    if (!isRecord(raw)) return null;
    return {
        source: stringField(raw, "source"),
        model: stringField(raw, "model"),
        project: stringField(raw, "project"),
        cwd: stringField(raw, "cwd"),
        started_at: dateField(raw, "started_at"),
        ended_at: dateField(raw, "ended_at"),
    };
};

export interface CostRow {
    readonly cost_usd: number | null;
    readonly estimated_tokens: number | null;
}
export const costSql = (ref: string): string =>
    `SELECT estimated_cost_usd, estimated_tokens FROM session_token_usage WHERE session = ${ref} LIMIT 1;`;
export const mapCost = (raw: unknown): CostRow | null => {
    if (!isRecord(raw)) return null;
    return { cost_usd: numField(raw, "estimated_cost_usd"), estimated_tokens: numField(raw, "estimated_tokens") };
};

// --- event inputs ----------------------------------------------------------

export interface ToolCallRow {
    readonly seq: number | null;
    readonly ts: string | null;
    readonly name: string;
    readonly command_norm: string | null;
    /** First 400 chars of input_json - codex edit detection peeks at the command. */
    readonly command_text: string | null;
    readonly output_excerpt: string | null;
    readonly error_text: string | null;
    readonly has_error: boolean;
    readonly call_id: string | null;
}
export const toolCallsSql = (ref: string): string =>
    `SELECT seq, ts, name, command_norm, string::slice(input_json ?? "", 0, 400) AS command_text, output_excerpt, error_text, has_error, call_id FROM tool_call WHERE session = ${ref} ORDER BY seq ASC LIMIT 6000;`;
export const mapToolCall = (raw: unknown): ToolCallRow | null => {
    if (!isRecord(raw)) return null;
    const name = stringField(raw, "name");
    if (!name) return null;
    return {
        seq: seqField(raw, "seq"),
        ts: dateField(raw, "ts"),
        name,
        command_norm: stringField(raw, "command_norm"),
        command_text: stringField(raw, "command_text"),
        output_excerpt: stringField(raw, "output_excerpt"),
        error_text: stringField(raw, "error_text"),
        has_error: boolField(raw, "has_error"),
        call_id: stringField(raw, "call_id"),
    };
};

export interface EditRow {
    readonly seq: number | null;
    readonly ts: string | null;
    readonly path: string | null;
    readonly edit_kind: string | null;
    readonly tool: string | null;
}
export const editsSql = (ref: string): string =>
    `SELECT in.seq AS seq, ts, path_seen AS path, edit_kind, tool FROM edited WHERE in.session = ${ref} ORDER BY seq ASC LIMIT 2000;`;
export const mapEdit = (raw: unknown): EditRow | null => {
    if (!isRecord(raw)) return null;
    return {
        seq: seqField(raw, "seq"),
        ts: dateField(raw, "ts"),
        path: stringField(raw, "path"),
        edit_kind: stringField(raw, "edit_kind"),
        tool: stringField(raw, "tool"),
    };
};

/** Full edit-tool inputs, fetched separately so the lean tool_call query stays
 *  cheap: counting +/- lines needs old_string/new_string/content, which the
 *  400-char command_text slice cannot carry. 32k slice bounds Write payloads;
 *  a truncated JSON simply yields no delta (best-effort). */
export interface EditStatRow {
    readonly seq: number | null;
    readonly name: string;
    readonly input_json: string | null;
}
export const editStatsSql = (ref: string): string =>
    `SELECT seq, name, string::slice(input_json ?? "", 0, 32000) AS input_json FROM tool_call WHERE session = ${ref} AND name IN ['Edit', 'Write', 'NotebookEdit'] ORDER BY seq ASC LIMIT 2000;`;
export const mapEditStat = (raw: unknown): EditStatRow | null => {
    if (!isRecord(raw)) return null;
    const name = stringField(raw, "name");
    if (!name) return null;
    return {
        seq: seqField(raw, "seq"),
        name,
        input_json: stringField(raw, "input_json"),
    };
};

export interface SkillRow {
    readonly seq: number | null;
    readonly ts: string | null;
    readonly name: string | null;
}
export const skillsSql = (ref: string): string =>
    `SELECT in.seq AS seq, ts, out.name AS name FROM invoked WHERE in.session = ${ref} AND out.name IS NOT NONE ORDER BY seq ASC LIMIT 2000;`;
export const mapSkill = (raw: unknown): SkillRow | null => {
    if (!isRecord(raw)) return null;
    const name = stringField(raw, "name");
    if (!name) return null;
    return { seq: seqField(raw, "seq"), ts: dateField(raw, "ts"), name };
};

export interface CorrectionRow {
    readonly seq: number | null;
    readonly ts: string | null;
    readonly target: string | null;
    readonly user_text: string | null;
}
/** Typed user-redirect signal (classifier), not the noisy `corrected_by` regex. */
export const correctionsSql = (ref: string): string =>
    `SELECT user_turn.seq AS seq, ts, target, user_text FROM reaction_event WHERE session = ${ref} AND (polarity = "revise" OR reaction_type = "correction") ORDER BY seq ASC LIMIT 500;`;
export const mapCorrection = (raw: unknown): CorrectionRow | null => {
    if (!isRecord(raw)) return null;
    return {
        seq: seqField(raw, "seq"),
        ts: dateField(raw, "ts"),
        target: stringField(raw, "target"),
        user_text: stringField(raw, "user_text"),
    };
};

/** Fallback correction source: turns the classifier tagged intent_kind=correction
 *  (catches redirects the reaction_event table missed). Merged + deduped by seq. */
export const intentCorrectionsSql = (ref: string): string =>
    `SELECT seq, ts, text_excerpt AS user_text FROM turn WHERE session = ${ref} AND intent_kind = "correction" ORDER BY seq ASC LIMIT 500;`;
export const mapIntentCorrection = (raw: unknown): CorrectionRow | null => {
    if (!isRecord(raw)) return null;
    return { seq: seqField(raw, "seq"), ts: dateField(raw, "ts"), target: null, user_text: stringField(raw, "user_text") };
};

export interface PlanRow {
    readonly ts: string | null;
    readonly summary: string | null;
    readonly items: string | null;
}
export const plansSql = (ref: string): string =>
    `SELECT ts, summary, items FROM plan_snapshot WHERE session = ${ref} ORDER BY ts ASC LIMIT 500;`;
export const mapPlan = (raw: unknown): PlanRow | null => {
    if (!isRecord(raw)) return null;
    return { ts: dateField(raw, "ts"), summary: stringField(raw, "summary"), items: stringField(raw, "items") };
};

export interface CommitRow {
    readonly ts: string | null;
    readonly sha: string | null;
    readonly message: string | null;
}
export const commitsSql = (ref: string): string =>
    `SELECT out.ts AS ts, out.sha AS sha, out.message AS message FROM produced WHERE in = ${ref} AND kind = "commit" ORDER BY ts ASC LIMIT 200;`;
export const mapCommit = (raw: unknown): CommitRow | null => {
    if (!isRecord(raw)) return null;
    return { ts: dateField(raw, "ts"), sha: stringField(raw, "sha"), message: stringField(raw, "message") };
};

export interface AskRow {
    readonly seq: number | null;
    readonly ts: string | null;
    readonly text: string | null;
}
/** User "asks" - segment boundaries. message_kind=task is the real prompt
 *  (skips control/context/tool-result user turns). */
export const asksSql = (ref: string): string =>
    `SELECT seq, ts, text_excerpt AS text FROM turn WHERE session = ${ref} AND role = "user" AND message_kind = "task" ORDER BY seq ASC LIMIT 1000;`;
export const mapAsk = (raw: unknown): AskRow | null => {
    if (!isRecord(raw)) return null;
    return { seq: seqField(raw, "seq"), ts: dateField(raw, "ts"), text: stringField(raw, "text") };
};

export interface CompactionRow {
    readonly ts: string | null;
}
export const compactionsSql = (ref: string): string =>
    `SELECT ts FROM compaction WHERE session = ${ref} ORDER BY ts ASC LIMIT 200;`;
export const mapCompaction = (raw: unknown): CompactionRow | null => {
    if (!isRecord(raw)) return null;
    const ts = dateField(raw, "ts");
    return ts ? { ts } : null;
};

export interface LastTurnRow {
    readonly seq: number | null;
    readonly ts: string | null;
    readonly text_excerpt: string | null;
}
export const lastAssistantSql = (ref: string): string =>
    `SELECT seq, ts, text_excerpt FROM turn WHERE session = ${ref} AND role = "assistant" ORDER BY seq DESC LIMIT 1;`;
export const mapLastTurn = (raw: unknown): LastTurnRow | null => {
    if (!isRecord(raw)) return null;
    return { seq: seqField(raw, "seq"), ts: dateField(raw, "ts"), text_excerpt: stringField(raw, "text_excerpt") };
};
