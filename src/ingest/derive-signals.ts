import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import { skillRecordKey } from "../lib/skill-id.ts";
import { AppLayer } from "../lib/layers.ts";
import type { DbError } from "../lib/errors.ts";
import { recordRef } from "./evidence-writers.ts";
import { surrealString } from "../lib/shared/surql.ts";

/**
 * Negation patterns that signal a user pushed back on the previous assistant
 * turn. Each entry is `[regex, label]` - the label is what we persist on the
 * `corrected_by.pattern` field so downstream queries can group by phrase.
 *
 * Patterns are matched against the first ~200 chars of the user turn text,
 * lowercased. Word boundaries keep us from firing on "actually" inside a URL
 * or "no" inside "node".
 */
const NEGATION_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
    // Hard interrupts logged by Claude Code itself - strongest correction
    // signal we have, since the user literally cancelled mid-tool-use.
    [/\[request interrupted by user/i, "interrupted"],
    [/\bno\b/, "no"],
    [/\bstop\b/, "stop"],
    [/\bwrong\b/, "wrong"],
    [/\bnot that\b/, "not that"],
    [/\bactually\b/, "actually"],
    [/\binstead\b/, "instead"],
    [/\bwait\b/, "wait"],
    [/\bhold on\b/, "hold on"],
    [/\byou missed\b/, "you missed"],
    [/\byou forgot\b/, "you forgot"],
] as const;

const CORRECTION_WINDOW_CHARS = 200;

function matchNegation(text: string): string | null {
    const head = text.slice(0, CORRECTION_WINDOW_CHARS).toLowerCase();
    for (const [re, label] of NEGATION_PATTERNS) {
        if (re.test(head)) return label;
    }
    return null;
}

/**
 * Build a deterministic edge record-id so re-runs upsert instead of
 * duplicating. Surreal record-ids escape via backticks, so we strip out the
 * `turn:` prefix and join the two raw keys.
 */
function correctedByEdgeId(fromTurnKey: string, toTurnKey: string): string {
    return `${fromTurnKey}__${toTurnKey}`;
}

function proposedEdgeId(fromTurnKey: string, skillKey: string): string {
    return `${fromTurnKey}__${skillKey}`;
}

/**
 * Deterministic edge id for `skill_paired`. Pair is treated as undirected, so
 * the lexicographically-smaller skill key always sits in the `in` slot. A
 * short hash of the joined keys keeps the id stable + length-bounded
 * regardless of skill-name length (Surreal record-id segment escaping).
 */
function skillPairedEdgeId(skillKeyA: string, skillKeyB: string): {
    edgeId: string;
    fromKey: string;
    toKey: string;
} {
    const [lo, hi] = skillKeyA < skillKeyB ? [skillKeyA, skillKeyB] : [skillKeyB, skillKeyA];
    const hash = Bun.hash(`${lo}__${hi}`).toString(16).slice(0, 12);
    return { edgeId: `${lo.slice(0, 24)}__${hi.slice(0, 24)}__${hash}`, fromKey: lo, toKey: hi };
}

function recoveredByEdgeId(fromTurnKey: string, skillKey: string): string {
    return `${fromTurnKey}__${skillKey}`;
}

type RecordRefLike = string | { tb?: string; id?: unknown };
type JsonRecord = Record<string, unknown>;
type TimestampInput = Date | string;

export interface ToolCallLike {
    readonly id?: RecordRefLike | null;
    readonly session?: RecordRefLike | null;
    readonly turn?: RecordRefLike | null;
    readonly tool?: RecordRefLike | { name?: unknown } | null;
    readonly tool_name?: string | null;
    readonly toolName?: string | null;
    readonly name?: string | null;
    readonly command_norm?: string | null;
    readonly commandNorm?: string | null;
    readonly output_excerpt?: string | null;
    readonly outputExcerpt?: string | null;
    readonly error_text?: string | null;
    readonly errorText?: string | null;
    readonly exit_code?: number | null;
    readonly exitCode?: number | null;
    readonly duration_ms?: number | null;
    readonly durationMs?: number | null;
    readonly status?: string | null;
    readonly has_error?: boolean | null;
    readonly hasError?: boolean | null;
    readonly ts?: TimestampInput | null;
    readonly cwd?: string | null;
    readonly seq?: number | null;
    readonly call_id?: string | null;
    readonly callId?: string | null;
    readonly repository?: RecordRefLike | null;
    readonly checkout?: RecordRefLike | null;
}

export interface DerivedFrictionEvent {
    readonly key: string;
    readonly kind: string;
    readonly sessionId: string | null;
    readonly turnKey: string | null;
    readonly targetType?: string;
    readonly targetName?: string;
    readonly source?: string;
    readonly confidence?: number;
    readonly text: string | null;
    readonly labels: JsonRecord;
    readonly metrics: JsonRecord;
    readonly raw: JsonRecord;
    readonly ts: string;
}

export interface DerivedDiagnosticEvent {
    readonly key: string;
    readonly kind: string;
    readonly status: string | null;
    readonly sessionId: string | null;
    readonly turnKey: string | null;
    readonly targetType?: string;
    readonly targetName?: string;
    readonly source?: string;
    readonly confidence?: number;
    readonly text: string | null;
    readonly labels: JsonRecord;
    readonly metrics: JsonRecord;
    readonly raw: JsonRecord;
    readonly ts: string;
}

export interface DerivedRecommendation {
    readonly key: string;
    readonly subjectType: string | null;
    readonly subjectId: string | null;
    readonly status: string;
    readonly text: string;
    readonly rationale: string;
    readonly labels: JsonRecord;
    readonly metrics: JsonRecord;
    readonly createdAt: string;
    readonly updatedAt: string | null;
}

const PAIR_WINDOW = 3;
const RECOVERY_WINDOW = 3;
const CHECKOUT_GUIDANCE_THRESHOLD = 3;

export function shouldDeriveAllTimeSkillPairs(
    sinceDays: number | undefined,
): boolean {
    return sinceDays === undefined || sinceDays <= 0;
}

interface TurnRow {
    id: { tb: string; id: string } | string;
    seq: number;
    role: string;
    text_excerpt: string | null;
    ts: string | Date;
    has_error: boolean;
    invoked_skills: ReadonlyArray<string>; // skill names this turn already invoked
    repository?: RecordRefLike | null;
    checkout?: RecordRefLike | null;
    cwd?: string | null;
}

interface SessionTurns {
    sessionId: string;
    repositoryKey: string | null;
    checkoutKey: string | null;
    cwd: string | null;
    turns: TurnRow[];
}

const sqlString = surrealString;

const sqlOptionString = (value: string | null | undefined): string =>
    value === null || value === undefined ? "NONE" : sqlString(value);

const sqlDate = (value: TimestampInput): string => {
    const iso = value instanceof Date ? value.toISOString() : value;
    return `d${JSON.stringify(iso)}`;
};

const sqlOptionDate = (value: TimestampInput | null | undefined): string =>
    value === null || value === undefined ? "NONE" : sqlDate(value);

const sqlOptionRecord = (
    table: string,
    key: string | null | undefined,
): string => (key === null || key === undefined ? "NONE" : recordRef(table, key));

const sqlJsonString = (value: unknown): string =>
    sqlString(typeof value === "string" ? value : JSON.stringify(value) ?? "null");

const sqlJsonOption = (value: unknown | null | undefined): string =>
    value === null || value === undefined ? "NONE" : sqlJsonString(value);

const sqlObject = (fields: readonly (readonly [string, string])[]): string =>
    `{ ${fields.map(([name, value]) => `${name}: ${value}`).join(", ")} }`;

const nonEmptyString = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
};

const compactRecord = (input: JsonRecord): JsonRecord =>
    Object.fromEntries(
        Object.entries(input).filter(([, value]) => value !== null && value !== undefined),
    );

const recordKeyPart = (value: unknown, expectedTable?: string): string | null => {
    if (value === null || value === undefined) return null;

    if (typeof value === "string") {
        let raw = value.trim();
        if (raw.length === 0) return null;
        const expectedPrefix = expectedTable ? `${expectedTable}:` : null;
        if (expectedPrefix && raw.startsWith(expectedPrefix)) {
            raw = raw.slice(expectedPrefix.length);
        } else {
            const colon = raw.indexOf(":");
            if (colon !== -1) raw = raw.slice(colon + 1);
        }
        if (
            (raw.startsWith("`") && raw.endsWith("`")) ||
            (raw.startsWith("⟨") && raw.endsWith("⟩"))
        ) {
            raw = raw.slice(1, -1);
        }
        return raw.length > 0 ? raw : null;
    }

    if (typeof value === "object" && "id" in value) {
        const id = (value as { id: unknown }).id;
        return id === null || id === undefined ? null : String(id);
    }

    return null;
};

const recordLabel = (table: string, value: unknown): string | null => {
    const key = recordKeyPart(value, table);
    return key === null ? null : `${table}:${key}`;
};

const isoTimestamp = (value: TimestampInput | null | undefined): string => {
    if (value instanceof Date) return value.toISOString();
    const text = nonEmptyString(value);
    return text ?? new Date(0).toISOString();
};

const safeKeyPart = (value: string): string => {
    const sanitized = value
        .replace(/:/g, "__")
        .replace(/[^a-zA-Z0-9_]+/g, "_")
        .replace(/_{3,}/g, "__")
        .replace(/^_+|_+$/g, "");
    return sanitized.length > 0 ? sanitized : Bun.hash(value).toString(16);
};

/** Extract the raw `id` portion of a turn record-id (`turn:⟨xyz⟩` → `xyz`). */
function rawTurnKey(id: TurnRow["id"]): string {
    return recordKeyPart(id, "turn") ?? String(id);
}

function tsToIso(ts: TurnRow["ts"]): string {
    return isoTimestamp(ts);
}

const toolCallStableKey = (call: ToolCallLike, index: number): string => {
    const idKey = recordKeyPart(call.id, "tool_call");
    if (idKey) return idKey;

    const sessionKey = recordKeyPart(call.session, "session") ?? "unknown_session";
    const callId = nonEmptyString(call.call_id) ?? nonEmptyString(call.callId);
    const seq = typeof call.seq === "number" ? `seq_${call.seq.toString(10)}` : null;
    const target = toolTargetName(call);
    const fallback = [sessionKey, callId ?? seq ?? target ?? `idx_${index}`].join("__");
    return `${safeKeyPart(fallback)}__${Bun.hash(fallback).toString(16)}`;
};

const callString = (
    call: ToolCallLike,
    snakeKey: keyof ToolCallLike,
    camelKey: keyof ToolCallLike,
): string | null => nonEmptyString(call[snakeKey]) ?? nonEmptyString(call[camelKey]);

const callNumber = (
    call: ToolCallLike,
    snakeKey: keyof ToolCallLike,
    camelKey: keyof ToolCallLike,
): number | null => {
    const value = call[snakeKey] ?? call[camelKey];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const toolNameFromTool = (tool: ToolCallLike["tool"]): string | null => {
    if (tool === null || tool === undefined) return null;
    if (typeof tool === "string") return recordKeyPart(tool, "tool") ?? tool;
    if (typeof tool === "object" && "name" in tool) return nonEmptyString(tool.name);
    return null;
};

const toolTargetName = (call: ToolCallLike): string =>
    callString(call, "command_norm", "commandNorm") ??
    nonEmptyString(call.tool_name) ??
    nonEmptyString(call.toolName) ??
    toolNameFromTool(call.tool) ??
    nonEmptyString(call.name) ??
    "unknown_tool";

const toolEvidenceText = (call: ToolCallLike): string | null =>
    callString(call, "error_text", "errorText") ??
    callString(call, "output_excerpt", "outputExcerpt");

const isFailedToolCall = (call: ToolCallLike): boolean => {
    if (call.has_error === true || call.hasError === true) return true;
    if ((call.status ?? "").toLowerCase() === "error") return true;
    const exitCode = callNumber(call, "exit_code", "exitCode");
    return exitCode !== null && exitCode !== 0;
};

const toolCallLabels = (
    call: ToolCallLike,
    toolCallKey: string,
    targetName: string,
): JsonRecord =>
    compactRecord({
        source: "derive_signals",
        evidenceSource: "tool_call",
        targetType: "tool",
        targetName,
        toolCallId: `tool_call:${toolCallKey}`,
        toolName: nonEmptyString(call.name),
        commandNorm: callString(call, "command_norm", "commandNorm"),
        repository: recordLabel("repository", call.repository),
        checkout: recordLabel("checkout", call.checkout),
        cwd: nonEmptyString(call.cwd),
    });

const toolCallMetrics = (call: ToolCallLike): JsonRecord =>
    compactRecord({
        confidence: 1,
        exitCode: callNumber(call, "exit_code", "exitCode"),
        durationMs: callNumber(call, "duration_ms", "durationMs"),
    });

const toolCallRaw = (
    call: ToolCallLike,
    toolCallKey: string,
    targetName: string,
): JsonRecord =>
    compactRecord({
        toolCallId: `tool_call:${toolCallKey}`,
        status: call.status ?? (isFailedToolCall(call) ? "error" : null),
        name: nonEmptyString(call.name),
        targetName,
        commandNorm: callString(call, "command_norm", "commandNorm"),
        exitCode: callNumber(call, "exit_code", "exitCode"),
    });

export function deriveFrictionFromToolCalls(
    calls: readonly ToolCallLike[],
): DerivedFrictionEvent[] {
    const out: DerivedFrictionEvent[] = [];
    calls.forEach((call, index) => {
        if (!isFailedToolCall(call)) return;
        const toolCallKey = toolCallStableKey(call, index);
        const targetName = toolTargetName(call);
        const labels = toolCallLabels(call, toolCallKey, targetName);
        const metrics = toolCallMetrics(call);
        out.push({
            key: `tool_error__${toolCallKey}`,
            kind: "tool_error",
            sessionId: recordKeyPart(call.session, "session"),
            turnKey: recordKeyPart(call.turn, "turn"),
            targetType: "tool",
            targetName,
            source: "tool_call",
            confidence: 1,
            text: toolEvidenceText(call),
            labels,
            metrics,
            raw: toolCallRaw(call, toolCallKey, targetName),
            ts: isoTimestamp(call.ts),
        });
    });
    return out;
}

export function deriveDiagnosticsFromToolCalls(
    calls: readonly ToolCallLike[],
): DerivedDiagnosticEvent[] {
    const out: DerivedDiagnosticEvent[] = [];
    calls.forEach((call, index) => {
        if (!isFailedToolCall(call)) return;
        const toolCallKey = toolCallStableKey(call, index);
        const targetName = toolTargetName(call);
        out.push({
            key: `tool_failure__${toolCallKey}`,
            kind: "tool_failure",
            status: "error",
            sessionId: recordKeyPart(call.session, "session"),
            turnKey: recordKeyPart(call.turn, "turn"),
            targetType: "tool",
            targetName,
            source: "tool_call",
            confidence: 1,
            text: toolEvidenceText(call),
            labels: toolCallLabels(call, toolCallKey, targetName),
            metrics: toolCallMetrics(call),
            raw: toolCallRaw(call, toolCallKey, targetName),
            ts: isoTimestamp(call.ts),
        });
    });
    return out;
}

const CHECKOUT_TEXT_RE =
    /\b(checkout|worktree|wrong\s+repo(?:sitory)?|branch|git\s+(?:status|checkout|worktree|switch))\b/i;

const isUserCorrectionFriction = (event: Pick<DerivedFrictionEvent, "kind" | "labels">): boolean => {
    const kind = event.kind.toLowerCase();
    if (kind === "user_correction" || kind === "correction") return true;
    return event.labels.kind === "user_correction" || event.labels.source === "corrected_by";
};

const labelString = (labels: JsonRecord, key: string): string | null =>
    nonEmptyString(labels[key]);

const checkoutCorrectionScope = (
    event: Pick<DerivedFrictionEvent, "labels">,
): { subjectType: string; subjectId: string } => {
    const labels = event.labels;
    const repository = labelString(labels, "repository") ?? labelString(labels, "repositoryId");
    if (repository) return { subjectType: "repository", subjectId: repository };

    const checkout = labelString(labels, "checkout") ?? labelString(labels, "checkoutId");
    if (checkout) return { subjectType: "checkout", subjectId: checkout };

    const scopeId = labelString(labels, "scopeId") ?? labelString(labels, "cwd");
    const scope = labelString(labels, "scope") ?? "scope";
    return { subjectType: scope, subjectId: scopeId ?? scope };
};

export function deriveRecommendationFromFriction(
    events: readonly Pick<DerivedFrictionEvent, "key" | "kind" | "text" | "labels" | "ts">[],
): DerivedRecommendation | null {
    const groups = new Map<
        string,
        {
            subjectType: string;
            subjectId: string;
            count: number;
            firstSeen: string;
            lastSeen: string;
            eventKeys: string[];
        }
    >();

    for (const event of events) {
        if (!isUserCorrectionFriction(event)) continue;
        if (!CHECKOUT_TEXT_RE.test(event.text ?? "")) continue;

        const scope = checkoutCorrectionScope(event);
        const groupKey = `${scope.subjectType}:${scope.subjectId}`;
        const ts = isoTimestamp(event.ts);
        const existing = groups.get(groupKey);
        if (existing) {
            existing.count += 1;
            existing.eventKeys.push(event.key);
            if (ts < existing.firstSeen) existing.firstSeen = ts;
            if (ts > existing.lastSeen) existing.lastSeen = ts;
        } else {
            groups.set(groupKey, {
                ...scope,
                count: 1,
                firstSeen: ts,
                lastSeen: ts,
                eventKeys: [event.key],
            });
        }
    }

    const winner = [...groups.values()]
        .filter((group) => group.count >= CHECKOUT_GUIDANCE_THRESHOLD)
        .sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen))[0];
    if (!winner) return null;

    const text =
        winner.subjectType === "repository"
            ? "Show just-in-time checkout guidance for this repository before edits, tests, or git commands."
            : "Show just-in-time checkout guidance for this scope before edits, tests, or git commands.";
    const rationale = `Observed ${winner.count} checkout-related user corrections for ${winner.subjectId}. Remind the agent to confirm checkout path, branch, and worktree before acting.`;
    const labels = compactRecord({
        source: "derive_signals",
        kind: "jit_checkout_guidance",
        trigger: "checkout_user_corrections",
        subjectType: winner.subjectType,
        subjectId: winner.subjectId,
        repository: winner.subjectType === "repository" ? winner.subjectId : null,
    });

    return {
        key: `jit_checkout_guidance__${safeKeyPart(winner.subjectId)}`,
        subjectType: winner.subjectType,
        subjectId: winner.subjectId,
        status: "open",
        text,
        rationale,
        labels,
        metrics: {
            correctionCount: winner.count,
            threshold: CHECKOUT_GUIDANCE_THRESHOLD,
            firstSeen: winner.firstSeen,
            lastSeen: winner.lastSeen,
            evidenceCount: winner.eventKeys.length,
        },
        createdAt: winner.firstSeen,
        updatedAt: winner.lastSeen,
    };
}

/**
 * Fetch every (session → turns) bundle in one round-trip. Each turn carries
 * its outgoing `->invoked->skill.name` array so we can detect "proposed but
 * not invoked" without a second query.
 */
const fetchSessionTurns = (
    sinceDays: number | undefined,
): Effect.Effect<SessionTurns[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const sinceFilter =
            sinceDays && sinceDays > 0 ? `WHERE ts > time::now() - ${sinceDays}d` : "";
        const sql = `
SELECT
    id,
    session,
    seq,
    role,
    text_excerpt,
    ts,
    has_error,
    session.repository AS repository,
    session.checkout AS checkout,
    session.cwd AS cwd,
    ->invoked->skill.name AS invoked_skills
FROM turn
${sinceFilter}
ORDER BY session ASC, seq ASC;`;
        const result = yield* db.query<[TurnRow[] & { session: unknown }[]]>(sql);
        const rows = (result?.[0] ?? []) as Array<TurnRow & { session: unknown }>;

        const bySession = new Map<string, TurnRow[]>();
        const metaBySession = new Map<
            string,
            { repositoryKey: string | null; checkoutKey: string | null; cwd: string | null }
        >();
        for (const row of rows) {
            const sess = row.session;
            const sessionId =
                typeof sess === "string"
                    ? sess.replace(/^session:/, "").replace(/[`⟨⟩]/g, "")
                    : sess && typeof sess === "object" && "id" in sess
                      ? String((sess as { id: unknown }).id)
                      : String(sess);
            const list = bySession.get(sessionId) ?? [];
            list.push(row);
            bySession.set(sessionId, list);
            if (!metaBySession.has(sessionId)) {
                metaBySession.set(sessionId, {
                    repositoryKey: recordKeyPart(row.repository, "repository"),
                    checkoutKey: recordKeyPart(row.checkout, "checkout"),
                    cwd: nonEmptyString(row.cwd),
                });
            }
        }
        return [...bySession.entries()].map(([sessionId, turns]) => ({
            sessionId,
            ...(metaBySession.get(sessionId) ?? {
                repositoryKey: null,
                checkoutKey: null,
                cwd: null,
            }),
            turns,
        }));
    });

interface CorrectionEdge {
    fromTurnKey: string;
    toTurnKey: string;
    pattern: string;
    text: string;
    ts: string;
    repositoryKey: string | null;
    checkoutKey: string | null;
    cwd: string | null;
    // Session + seq of the corrected (assistant) turn. Used to mark
    // invoked edges as `was_corrected = true` for any invocation whose
    // turn falls in [correctedSeq - 3, correctedSeq] (matches the
    // pre-denormalisation cmdTaste +3 seq window). See issue #31.
    correctedSession: string;
    correctedSeq: number;
}

interface ProposedEdge {
    fromTurnKey: string;
    skillKey: string;
    skillName: string;
    ts: string;
    contextExcerpt: string;
}

/**
 * Walk turns in order. Whenever a user turn arrives, look back for the most
 * recent assistant turn (skipping tool_call / reasoning / function_call_output
 * noise that interleaves between assistant generations and user replies). If
 * the user text starts with a negation pattern, emit a correction edge from
 * that assistant turn to the user turn.
 */
function deriveCorrections(bundle: SessionTurns): CorrectionEdge[] {
    const out: CorrectionEdge[] = [];
    const turns = bundle.turns;
    let lastAssistantIdx: number | null = null;
    for (let i = 0; i < turns.length; i += 1) {
        const t = turns[i];
        if (t.role === "assistant") {
            lastAssistantIdx = i;
            continue;
        }
        if (t.role !== "user") continue;
        const text = t.text_excerpt;
        // Tool-result user turns carry no text excerpt - skip without
        // disturbing the anchor (this is what was masking interrupted-by-user
        // turns, which sit immediately after a tool_result user turn).
        if (!text) continue;
        if (lastAssistantIdx === null) continue;
        const matched = matchNegation(text);
        if (matched) {
            const prev = turns[lastAssistantIdx];
            out.push({
                fromTurnKey: rawTurnKey(prev.id),
                toTurnKey: rawTurnKey(t.id),
                pattern: matched,
                text,
                ts: tsToIso(t.ts),
                repositoryKey: bundle.repositoryKey,
                checkoutKey: bundle.checkoutKey,
                cwd: bundle.cwd,
                correctedSession: bundle.sessionId,
                correctedSeq: prev.seq,
            });
        }
        // After a user turn fires, reset the anchor so the next correction
        // must follow a fresh assistant turn.
        lastAssistantIdx = null;
    }
    return out;
}

/**
 * For each assistant turn whose excerpt mentions a known skill name but did
 * NOT outgoing-invoke that skill, emit a `proposed` edge. Substring match is
 * case-sensitive on the canonical skill name to avoid `gsd:plan-phase`
 * matching the word "plan" everywhere.
 */
function deriveProposed(
    bundle: SessionTurns,
    skillNames: ReadonlyArray<string>,
): ProposedEdge[] {
    if (skillNames.length === 0) return [];
    const out: ProposedEdge[] = [];
    for (const turn of bundle.turns) {
        if (turn.role !== "assistant") continue;
        const text = turn.text_excerpt;
        if (!text) continue;
        const invokedSet = new Set(turn.invoked_skills ?? []);
        for (const name of skillNames) {
            if (invokedSet.has(name)) continue;
            if (!text.includes(name)) continue;
            // Skip trivially-short names that would create noise (e.g. "ci").
            if (name.length < 4) continue;
            const idx = text.indexOf(name);
            const start = Math.max(0, idx - 40);
            const end = Math.min(text.length, idx + name.length + 40);
            out.push({
                fromTurnKey: rawTurnKey(turn.id),
                skillKey: skillRecordKey(name),
                skillName: name,
                ts: tsToIso(turn.ts),
                contextExcerpt: text.slice(start, end),
            });
        }
    }
    return out;
}

interface SkillPairAccum {
    fromKey: string;
    toKey: string;
    count: number;
    lastSeen: string; // ISO
}

interface RecoveryEdge {
    fromTurnKey: string;
    skillKey: string;
    skillName: string;
    ts: string;
    errorExcerpt: string | null;
}

/**
 * Walk turns in seq order. For every pair of `invoked` skills firing within
 * `PAIR_WINDOW` turns of each other in the same session, accumulate a
 * count + max(ts). Pairs are undirected (sorted lexicographically) so
 * `(a,b)` and `(b,a)` collapse to a single edge. Skills invoked together in
 * the same turn count too (window includes seq delta = 0).
 */
function deriveSkillPairs(
    bundle: SessionTurns,
    accum: Map<string, SkillPairAccum>,
): void {
    const turns = bundle.turns;
    // Dedupe invoked_skills per turn: a single assistant turn can fire the
    // same tool dozens of times (e.g. codex:exec_command 30x in one turn),
    // and we don't want that to multiply the pair count quadratically.
    const skillsByTurn = turns.map((t) => [...new Set(t.invoked_skills ?? [])]);
    for (let i = 0; i < turns.length; i += 1) {
        const a = turns[i];
        const aSkills = skillsByTurn[i];
        if (aSkills.length === 0) continue;
        for (let j = i; j < turns.length; j += 1) {
            const b = turns[j];
            if (b.seq - a.seq > PAIR_WINDOW) break;
            const bSkills = skillsByTurn[j];
            if (bSkills.length === 0) continue;
            for (const sa of aSkills) {
                for (const sb of bSkills) {
                    if (sa === sb) continue;
                    // Same turn pair: avoid double-counting the unordered pair.
                    if (i === j && sa > sb) continue;
                    const keyA = skillRecordKey(sa);
                    const keyB = skillRecordKey(sb);
                    const { edgeId, fromKey, toKey } = skillPairedEdgeId(keyA, keyB);
                    const ts = tsToIso(b.ts);
                    const existing = accum.get(edgeId);
                    if (existing) {
                        existing.count += 1;
                        if (ts > existing.lastSeen) existing.lastSeen = ts;
                    } else {
                        accum.set(edgeId, {
                            fromKey,
                            toKey,
                            count: 1,
                            lastSeen: ts,
                        });
                    }
                }
            }
        }
    }
}

/**
 * For each turn whose `has_error` flag is true, look forward up to
 * `RECOVERY_WINDOW` seq steps for the next `invoked` skill in the same
 * session and emit a `recovered_by` edge from the erroring turn to that
 * skill. Only the first invocation in the window counts (one recovery per
 * error).
 */
function deriveRecovered(bundle: SessionTurns): RecoveryEdge[] {
    const out: RecoveryEdge[] = [];
    const turns = bundle.turns;
    for (let i = 0; i < turns.length; i += 1) {
        const t = turns[i];
        if (!t.has_error) continue;
        const errorTurnKey = rawTurnKey(t.id);
        const excerpt = t.text_excerpt;
        for (let j = i + 1; j < turns.length; j += 1) {
            const next = turns[j];
            if (next.seq - t.seq > RECOVERY_WINDOW) break;
            const skills = next.invoked_skills ?? [];
            if (skills.length === 0) continue;
            for (const name of skills) {
                out.push({
                    fromTurnKey: errorTurnKey,
                    skillKey: skillRecordKey(name),
                    skillName: name,
                    ts: tsToIso(next.ts),
                    errorExcerpt: excerpt,
                });
            }
            break; // first invocation window-step wins
        }
    }
    return out;
}

function deriveFrictionFromCorrections(edges: readonly CorrectionEdge[]): DerivedFrictionEvent[] {
    return edges.map((edge) => {
        const repository = edge.repositoryKey ? `repository:${edge.repositoryKey}` : null;
        const checkout = edge.checkoutKey ? `checkout:${edge.checkoutKey}` : null;
        const scope =
            repository !== null ? "repository" : checkout !== null ? "checkout" : edge.cwd ? "workspace" : "session";
        const scopeId = repository ?? checkout ?? edge.cwd ?? edge.correctedSession;

        return {
            key: `user_correction__${edge.toTurnKey}`,
            kind: "user_correction",
            sessionId: edge.correctedSession,
            turnKey: edge.toTurnKey,
            source: "corrected_by",
            confidence: 0.8,
            text: edge.text,
            labels: compactRecord({
                source: "corrected_by",
                kind: "user_correction",
                pattern: edge.pattern,
                repository,
                checkout,
                cwd: edge.cwd,
                scope,
                scopeId,
            }),
            metrics: {
                confidence: 0.8,
            },
            raw: {
                correctedTurn: `turn:${edge.fromTurnKey}`,
                correctionTurn: `turn:${edge.toTurnKey}`,
                correctedSeq: edge.correctedSeq,
            },
            ts: edge.ts,
        };
    });
}

const fetchSkillNames = (): Effect.Effect<string[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const result = yield* db.query<[Array<{ name: string }>]>(
            `SELECT name FROM skill;`,
        );
        return (result?.[0] ?? []).map((r) => r.name).filter((n): n is string => Boolean(n));
    });

const fetchFailedToolCalls = (
    sinceDays: number | undefined,
): Effect.Effect<ToolCallLike[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const sinceFilter =
            sinceDays && sinceDays > 0 ? `AND ts > time::now() - ${sinceDays}d` : "";
        const sql = `
SELECT
    id,
    session,
    turn,
    tool,
    tool.name AS tool_name,
    name,
    ts,
    status,
    command_norm,
    output_excerpt,
    error_text,
    exit_code,
    duration_ms,
    has_error,
    cwd,
    seq,
    call_id,
    session.repository AS repository,
    session.checkout AS checkout
FROM tool_call
WHERE has_error = true ${sinceFilter}
ORDER BY ts DESC;`;
        const result = yield* db.query<[ToolCallLike[]]>(sql);
        return result?.[0] ?? [];
    });

/**
 * Idempotent RELATE on the `corrected_by` relation. SurrealDB rejects raw
 * `UPSERT` against a RELATION-typed table ("is not a relation"), but
 * `RELATE in -> table:⟨id⟩ -> out` overwrites in place when the same edge
 * record-id is reused. Building the id deterministically from both endpoint
 * keys keeps re-runs side-effect-free.
 */
const upsertCorrections = (edges: CorrectionEdge[]) =>
    Effect.gen(function* () {
        if (edges.length === 0) return;
        const db = yield* SurrealClient;
        const stmts = edges.map((e) => {
            const edgeId = correctedByEdgeId(e.fromTurnKey, e.toTurnKey);
            return `RELATE turn:\`${e.fromTurnKey}\` -> corrected_by:\`${edgeId}\` -> turn:\`${e.toTurnKey}\` SET pattern = ${sqlString(e.pattern)}, ts = d"${e.ts}";`;
        });
        for (let i = 0; i < stmts.length; i += 500) {
            yield* db.query(stmts.slice(i, i + 500).join(""));
        }
    });

/**
 * For each correction edge, mark every `invoked` edge whose source turn falls
 * in `[correctedSeq - 3, correctedSeq]` of the same session as
 * `was_corrected = true`. This denormalises the +3-seq-window check that
 * cmdTaste's `corrections` subquery used to do per row (~6s on the largest
 * skill); after this, the same count becomes a single GROUP BY scan with no
 * record fetch. See issue #31.
 *
 * The window is inclusive on both ends: an invocation IS considered
 * corrected if its turn is the one that got pushed back, OR if a later turn
 * within 3 steps got pushed back. Mirrors the original SurrealQL predicate
 * `in.seq >= $parent.in.seq AND in.seq <= $parent.in.seq + 3`.
 */
const markWasCorrected = (edges: CorrectionEdge[]) =>
    Effect.gen(function* () {
        if (edges.length === 0) return;
        const db = yield* SurrealClient;
        // Build the universe of (session, seq) tuples that should be marked.
        // Multiple correction edges may overlap; dedupe via a Set keyed by
        // the deterministic turn record-key so we issue exactly one UPDATE
        // per turn regardless of overlap.
        const turnsToMark = new Set<string>();
        for (const e of edges) {
            const lo = Math.max(1, e.correctedSeq - 3);
            const hi = e.correctedSeq;
            for (let seq = lo; seq <= hi; seq += 1) {
                // turnRecordKey strips `-` from session id; replicate inline
                // (separate file so we can't import the private helper).
                const sess = e.correctedSession.replace(/-/g, "");
                turnsToMark.add(`${sess}_${seq}`);
            }
        }
        if (turnsToMark.size === 0) return;
        const stmts = [...turnsToMark].map(
            (turnKey) =>
                `UPDATE invoked SET was_corrected = true WHERE in = turn:\`${turnKey}\` RETURN NONE;`,
        );
        for (let i = 0; i < stmts.length; i += 500) {
            yield* db.query(stmts.slice(i, i + 500).join(""));
        }
    });

const upsertProposed = (edges: ProposedEdge[]) =>
    Effect.gen(function* () {
        if (edges.length === 0) return;
        const db = yield* SurrealClient;
        const stmts = edges.map((e) => {
            const edgeId = proposedEdgeId(e.fromTurnKey, e.skillKey);
            return `RELATE turn:\`${e.fromTurnKey}\` -> proposed:\`${edgeId}\` -> skill:\`${e.skillKey}\` SET ts = d"${e.ts}", context_excerpt = ${sqlString(e.contextExcerpt)};`;
        });
        for (let i = 0; i < stmts.length; i += 500) {
            yield* db.query(stmts.slice(i, i + 500).join(""));
        }
    });

/**
 * Idempotent RELATE for `skill_paired`. We aggregate counts in-memory across
 * all sessions in scope, then RELATE once per unique pair using a
 * deterministic edge id so re-running `derive-signals` overwrites in place
 * with identical totals (no count drift from re-fires).
 */
const upsertSkillPairs = (pairs: SkillPairAccum[], edgeIds: string[]) =>
    Effect.gen(function* () {
        if (pairs.length === 0) return;
        const db = yield* SurrealClient;
        const stmts = pairs.map((p, i) => {
            const edgeId = edgeIds[i];
            return `RELATE skill:\`${p.fromKey}\` -> skill_paired:\`${edgeId}\` -> skill:\`${p.toKey}\` SET count = ${p.count}, last_seen = d"${p.lastSeen}";`;
        });
        for (let i = 0; i < stmts.length; i += 500) {
            yield* db.query(stmts.slice(i, i + 500).join(""));
        }
    });

const upsertRecovered = (edges: RecoveryEdge[]) =>
    Effect.gen(function* () {
        if (edges.length === 0) return;
        const db = yield* SurrealClient;
        const stmts = edges.map((e) => {
            const edgeId = recoveredByEdgeId(e.fromTurnKey, e.skillKey);
            const excerpt =
                e.errorExcerpt === null ? "NONE" : sqlString(e.errorExcerpt);
            return `RELATE turn:\`${e.fromTurnKey}\` -> recovered_by:\`${edgeId}\` -> skill:\`${e.skillKey}\` SET ts = d"${e.ts}", error_excerpt = ${excerpt};`;
        });
        for (let i = 0; i < stmts.length; i += 500) {
            yield* db.query(stmts.slice(i, i + 500).join(""));
        }
    });

const upsertFrictionEvents = (events: readonly DerivedFrictionEvent[]) =>
    Effect.gen(function* () {
        if (events.length === 0) return;
        const db = yield* SurrealClient;
        const stmts = events.map(
            (event) =>
                `UPSERT ${recordRef("friction_event", event.key)} MERGE ${sqlObject([
                    ["session", sqlOptionRecord("session", event.sessionId)],
                    ["turn", sqlOptionRecord("turn", event.turnKey)],
                    ["kind", sqlString(event.kind)],
                    ["text", sqlOptionString(event.text)],
                    ["labels", sqlJsonOption(event.labels)],
                    ["metrics", sqlJsonOption(event.metrics)],
                    ["raw", sqlJsonOption(event.raw)],
                    ["ts", sqlDate(event.ts)],
                ])};`,
        );
        for (let i = 0; i < stmts.length; i += 500) {
            yield* db.query(stmts.slice(i, i + 500).join(""));
        }
    });

const upsertDiagnosticEvents = (events: readonly DerivedDiagnosticEvent[]) =>
    Effect.gen(function* () {
        if (events.length === 0) return;
        const db = yield* SurrealClient;
        const stmts = events.map(
            (event) =>
                `UPSERT ${recordRef("diagnostic_event", event.key)} MERGE ${sqlObject([
                    ["session", sqlOptionRecord("session", event.sessionId)],
                    ["turn", sqlOptionRecord("turn", event.turnKey)],
                    ["kind", sqlString(event.kind)],
                    ["status", sqlOptionString(event.status)],
                    ["text", sqlOptionString(event.text)],
                    ["labels", sqlJsonOption(event.labels)],
                    ["metrics", sqlJsonOption(event.metrics)],
                    ["raw", sqlJsonOption(event.raw)],
                    ["ts", sqlDate(event.ts)],
                ])};`,
        );
        for (let i = 0; i < stmts.length; i += 500) {
            yield* db.query(stmts.slice(i, i + 500).join(""));
        }
    });

const upsertRecommendations = (recommendations: readonly DerivedRecommendation[]) =>
    Effect.gen(function* () {
        if (recommendations.length === 0) return;
        const db = yield* SurrealClient;
        const stmts = recommendations.map(
            (recommendation) =>
                `UPSERT ${recordRef("recommendation", recommendation.key)} MERGE ${sqlObject([
                    ["subject_type", sqlOptionString(recommendation.subjectType)],
                    ["subject_id", sqlOptionString(recommendation.subjectId)],
                    ["status", sqlString(recommendation.status)],
                    ["text", sqlString(recommendation.text)],
                    ["rationale", sqlOptionString(recommendation.rationale)],
                    ["labels", sqlJsonOption(recommendation.labels)],
                    ["metrics", sqlJsonOption(recommendation.metrics)],
                    ["created_at", sqlDate(recommendation.createdAt)],
                    ["updated_at", sqlOptionDate(recommendation.updatedAt)],
                ])};`,
        );
        for (let i = 0; i < stmts.length; i += 500) {
            yield* db.query(stmts.slice(i, i + 500).join(""));
        }
    });

export interface DeriveStats {
    sessions: number;
    turns: number;
    corrections: number;
    proposed: number;
    skillPairs: number;
    recoveries: number;
    frictionEvents: number;
    diagnosticEvents: number;
    recommendations: number;
}

export interface DeriveOpts {
    sinceDays: number | undefined;
    onProgress: (counts: Record<string, number>) => Effect.Effect<void>;
}

export const deriveSignals = (
    opts: Partial<DeriveOpts> = {},
): Effect.Effect<DeriveStats, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const skillNames = yield* fetchSkillNames();
        const bundles = yield* fetchSessionTurns(opts.sinceDays);
        if (opts.onProgress) yield* opts.onProgress({ sessions: bundles.length });

        let corrections = 0;
        let proposed = 0;
        let turnCount = 0;
        let recoveries = 0;

        const correctionBatch: CorrectionEdge[] = [];
        const proposedBatch: ProposedEdge[] = [];
        const recoveryBatch: RecoveryEdge[] = [];
        const pairsAccum = new Map<string, SkillPairAccum>();

        for (const [index, bundle] of bundles.entries()) {
            turnCount += bundle.turns.length;
            const c = deriveCorrections(bundle);
            const p = deriveProposed(bundle, skillNames);
            const r = deriveRecovered(bundle);
            corrections += c.length;
            proposed += p.length;
            recoveries += r.length;
            correctionBatch.push(...c);
            proposedBatch.push(...p);
            recoveryBatch.push(...r);
            deriveSkillPairs(bundle, pairsAccum);
            if (opts.onProgress && (index < 5 || (index + 1) % 50 === 0)) {
                yield* opts.onProgress({
                    currentFile: index + 1,
                    totalFiles: bundles.length,
                    sessions: index + 1,
                    turns: turnCount,
                    corrections,
                    proposed,
                    recoveries,
                    skillPairs: pairsAccum.size,
                });
            }
        }

        const shouldWriteSkillPairs = shouldDeriveAllTimeSkillPairs(opts.sinceDays);
        const pairsList = shouldWriteSkillPairs ? [...pairsAccum.values()] : [];
        const pairEdgeIds = shouldWriteSkillPairs ? [...pairsAccum.keys()] : [];
        if (opts.onProgress) {
            yield* opts.onProgress({
                sessions: bundles.length,
                turns: turnCount,
                corrections,
                proposed,
                recoveries,
                skillPairs: pairsList.length,
            });
        }
        const failedToolCalls = yield* fetchFailedToolCalls(opts.sinceDays);
        const toolFrictionBatch = deriveFrictionFromToolCalls(failedToolCalls);
        const correctionFrictionBatch = deriveFrictionFromCorrections(correctionBatch);
        const frictionBatch = [...toolFrictionBatch, ...correctionFrictionBatch];
        const diagnosticBatch = deriveDiagnosticsFromToolCalls(failedToolCalls);
        const recommendation = deriveRecommendationFromFriction(correctionFrictionBatch);
        const recommendationBatch = recommendation === null ? [] : [recommendation];
        if (opts.onProgress) {
            yield* opts.onProgress({
                sessions: bundles.length,
                turns: turnCount,
                corrections,
                proposed,
                recoveries,
                skillPairs: pairsList.length,
                frictionEvents: frictionBatch.length,
                diagnosticEvents: diagnosticBatch.length,
                recommendations: recommendationBatch.length,
            });
        }

        yield* upsertCorrections(correctionBatch);
        // Denormalise was_corrected onto invoked edges so cmdTaste's
        // corrections subquery becomes a pure index/scan filter (issue #31).
        yield* markWasCorrected(correctionBatch);
        yield* upsertProposed(proposedBatch);
        if (shouldWriteSkillPairs) {
            yield* upsertSkillPairs(pairsList, pairEdgeIds);
        }
        yield* upsertRecovered(recoveryBatch);
        yield* upsertFrictionEvents(frictionBatch);
        yield* upsertDiagnosticEvents(diagnosticBatch);
        yield* upsertRecommendations(recommendationBatch);

        yield* Effect.logDebug("signals derived", {
            sessions: bundles.length,
            turns: turnCount,
            corrections,
            proposed,
            skillPairs: pairsList.length,
            recoveries,
            frictionEvents: frictionBatch.length,
            diagnosticEvents: diagnosticBatch.length,
            recommendations: recommendationBatch.length,
        });
        return {
            sessions: bundles.length,
            turns: turnCount,
            corrections,
            proposed,
            skillPairs: pairsList.length,
            recoveries,
            frictionEvents: frictionBatch.length,
            diagnosticEvents: diagnosticBatch.length,
            recommendations: recommendationBatch.length,
        };
    });

if (import.meta.main) {
    const sinceArg = process.argv.find((a) => a.startsWith("--since="));
    const sinceDays = sinceArg ? parseInt(sinceArg.split("=")[1], 10) : undefined;
    await Effect.runPromise(
        deriveSignals({ sinceDays }).pipe(
            Effect.provide(AppLayer),
            Effect.scoped,
        ) as Effect.Effect<DeriveStats>,
    );
}
