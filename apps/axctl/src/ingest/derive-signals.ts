import { Effect, Schema } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { skillRecordKey } from "@ax/lib/skill-id";
import { AppLayer } from "@ax/lib/layers";
import type { DbError } from "@ax/lib/errors";
import { recordRef } from "./evidence-writers.ts";
import { surrealDate, surrealJsonTextOption, surrealObject, surrealOptionRecord, surrealOptionString, surrealString } from "@ax/lib/shared/surql";
import { executeStatementsWith } from "@ax/lib/shared/statement-exec";
import { isoTimestamp, nonEmptyString, recordKeyPart, safeKeyPart } from "@ax/lib/shared/derive-keys";
import type {
    CorrectionEdge, DerivedDiagnosticEvent, DerivedFrictionEvent, JsonRecord,
    ProposedEdge, RecoveryEdge, SessionTurns, SkillPairAccum,
    ToolCallLike, TurnRow,
} from "./signals/types.ts";
export type { DerivedDiagnosticEvent, DerivedFrictionEvent, SessionTurns, SkillPairAccum, ToolCallLike, TurnRow } from "./signals/types.ts";

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

export function matchNegation(text: string): string | null {
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
export function correctedByEdgeId(fromTurnKey: string, toTurnKey: string): string {
    return `${fromTurnKey}__${toTurnKey}`;
}

export function proposedEdgeId(fromTurnKey: string, skillKey: string): string {
    return `${fromTurnKey}__${skillKey}`;
}

/**
 * Deterministic edge id for `skill_paired`. Pair is treated as undirected, so
 * the lexicographically-smaller skill key always sits in the `in` slot. A
 * short hash of the joined keys keeps the id stable + length-bounded
 * regardless of skill-name length (Surreal record-id segment escaping).
 */
export function skillPairedEdgeId(skillKeyA: string, skillKeyB: string): {
    edgeId: string;
    fromKey: string;
    toKey: string;
} {
    const [lo, hi] = skillKeyA < skillKeyB ? [skillKeyA, skillKeyB] : [skillKeyB, skillKeyA];
    const hash = Bun.hash(`${lo}__${hi}`).toString(16).slice(0, 12);
    return { edgeId: `${lo.slice(0, 24)}__${hi.slice(0, 24)}__${hash}`, fromKey: lo, toKey: hi };
}

export function recoveredByEdgeId(fromTurnKey: string, skillKey: string): string {
    return `${fromTurnKey}__${skillKey}`;
}

const PAIR_WINDOW = 3;
const RECOVERY_WINDOW = 3;

export function shouldDeriveAllTimeSkillPairs(
    sinceDays: number | undefined,
): boolean {
    return sinceDays === undefined || sinceDays <= 0;
}

const compactRecord = (input: JsonRecord): JsonRecord =>
    Object.fromEntries(
        Object.entries(input).filter(([, value]) => value !== null && value !== undefined),
    );

const recordLabel = (table: string, value: unknown): string | null => {
    const key = recordKeyPart(value, table);
    return key === null ? null : `${table}:${key}`;
};


/** Extract the raw `id` portion of a turn record-id (`turn:⟨xyz⟩` → `xyz`). */
function rawTurnKey(id: TurnRow["id"]): string {
    return recordKeyPart(id, "turn") ?? String(id);
}

function tsToIso(ts: TurnRow["ts"]): string {
    return isoTimestamp(ts);
}

export const toolCallStableKey = (call: ToolCallLike, index: number): string => {
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

/** Pure grouping of raw turn rows into per-session bundles. Session ids come
 *  back from Surreal as either `session:⟨id⟩` strings or `{ tb, id }` objects;
 *  both normalize to the bare key. First row wins for repo/checkout/cwd meta. */
export function groupTurnsBySession(
    rows: ReadonlyArray<TurnRow & { session: unknown }>,
): SessionTurns[] {
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
        const sinceFilter = sinceWhereClause(sinceDays);
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
        return groupTurnsBySession(rows);
    });

/**
 * Walk turns in order. Whenever a user turn arrives, look back for the most
 * recent assistant turn (skipping tool_call / reasoning / function_call_output
 * noise that interleaves between assistant generations and user replies). If
 * the user text starts with a negation pattern, emit a correction edge from
 * that assistant turn to the user turn.
 */
export function deriveCorrections(bundle: SessionTurns): CorrectionEdge[] {
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
export function deriveProposed(
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

/**
 * Walk turns in seq order. For every pair of `invoked` skills firing within
 * `PAIR_WINDOW` turns of each other in the same session, accumulate a
 * count + max(ts). Pairs are undirected (sorted lexicographically) so
 * `(a,b)` and `(b,a)` collapse to a single edge. Skills invoked together in
 * the same turn count too (window includes seq delta = 0).
 */
export function deriveSkillPairs(
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
export function deriveRecovered(bundle: SessionTurns): RecoveryEdge[] {
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

export function deriveFrictionFromCorrections(edges: readonly CorrectionEdge[]): DerivedFrictionEvent[] {
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
        const sinceFilter = sinceAndClause(sinceDays);
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
            return `RELATE turn:\`${e.fromTurnKey}\` -> corrected_by:\`${edgeId}\` -> turn:\`${e.toTurnKey}\` SET pattern = ${surrealString(e.pattern)}, ts = d"${e.ts}";`;
        });
        yield* executeStatementsWith(db, stmts, { chunkSize: 500 });
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
        yield* executeStatementsWith(db, stmts, { chunkSize: 500 });
    });

const upsertProposed = (edges: ProposedEdge[]) =>
    Effect.gen(function* () {
        if (edges.length === 0) return;
        const db = yield* SurrealClient;
        const stmts = edges.map((e) => {
            const edgeId = proposedEdgeId(e.fromTurnKey, e.skillKey);
            return `RELATE turn:\`${e.fromTurnKey}\` -> proposed:\`${edgeId}\` -> skill:\`${e.skillKey}\` SET ts = d"${e.ts}", context_excerpt = ${surrealString(e.contextExcerpt)};`;
        });
        yield* executeStatementsWith(db, stmts, { chunkSize: 500 });
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
        yield* executeStatementsWith(db, stmts, { chunkSize: 500 });
    });

const upsertRecovered = (edges: RecoveryEdge[]) =>
    Effect.gen(function* () {
        if (edges.length === 0) return;
        const db = yield* SurrealClient;
        const stmts = edges.map((e) => {
            const edgeId = recoveredByEdgeId(e.fromTurnKey, e.skillKey);
            const excerpt =
                e.errorExcerpt == null ? "NONE" : surrealString(e.errorExcerpt);
            return `RELATE turn:\`${e.fromTurnKey}\` -> recovered_by:\`${edgeId}\` -> skill:\`${e.skillKey}\` SET ts = d"${e.ts}", error_excerpt = ${excerpt};`;
        });
        yield* executeStatementsWith(db, stmts, { chunkSize: 500 });
    });

const upsertFrictionEvents = (events: readonly DerivedFrictionEvent[]) =>
    Effect.gen(function* () {
        if (events.length === 0) return;
        const db = yield* SurrealClient;
        const stmts = events.map(
            (event) =>
                `UPSERT ${recordRef("friction_event", event.key)} MERGE ${surrealObject([
                    ["session", surrealOptionRecord("session", event.sessionId)],
                    ["turn", surrealOptionRecord("turn", event.turnKey)],
                    ["kind", surrealString(event.kind)],
                    ["text", surrealOptionString(event.text)],
                    ["labels", surrealJsonTextOption(event.labels)],
                    ["metrics", surrealJsonTextOption(event.metrics)],
                    ["raw", surrealJsonTextOption(event.raw)],
                    ["ts", surrealDate(event.ts)],
                ])};`,
        );
        yield* executeStatementsWith(db, stmts, { chunkSize: 500 });
    });

const upsertDiagnosticEvents = (events: readonly DerivedDiagnosticEvent[]) =>
    Effect.gen(function* () {
        if (events.length === 0) return;
        const db = yield* SurrealClient;
        const stmts = events.map(
            (event) =>
                `UPSERT ${recordRef("diagnostic_event", event.key)} MERGE ${surrealObject([
                    ["session", surrealOptionRecord("session", event.sessionId)],
                    ["turn", surrealOptionRecord("turn", event.turnKey)],
                    ["kind", surrealString(event.kind)],
                    ["status", surrealOptionString(event.status)],
                    ["text", surrealOptionString(event.text)],
                    ["labels", surrealJsonTextOption(event.labels)],
                    ["metrics", surrealJsonTextOption(event.metrics)],
                    ["raw", surrealJsonTextOption(event.raw)],
                    ["ts", surrealDate(event.ts)],
                ])};`,
        );
        yield* executeStatementsWith(db, stmts, { chunkSize: 500 });
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
}

export interface DeriveOpts {
    sinceDays: number | undefined;
    onProgress: (counts: Record<string, number>) => Effect.Effect<void>;
}

export const deriveSignals = (
    opts: Partial<DeriveOpts> = {},
): Effect.Effect<DeriveStats, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const skillNames = yield* fetchSkillNames().pipe(
            Effect.withSpan("signals.fetch-skills"),
        );
        const bundles = yield* fetchSessionTurns(opts.sinceDays).pipe(
            Effect.tap((b) => Effect.annotateCurrentSpan("signals.sessions", b.length)),
            Effect.withSpan("signals.fetch-turns"),
        );
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
        const failedToolCalls = yield* fetchFailedToolCalls(opts.sinceDays).pipe(
            Effect.tap((calls) => Effect.annotateCurrentSpan("signals.failed_tool_calls", calls.length)),
            Effect.withSpan("signals.fetch-failed-tools"),
        );
        const toolFrictionBatch = deriveFrictionFromToolCalls(failedToolCalls);
        const correctionFrictionBatch = deriveFrictionFromCorrections(correctionBatch);
        const frictionBatch = [...toolFrictionBatch, ...correctionFrictionBatch];
        const diagnosticBatch = deriveDiagnosticsFromToolCalls(failedToolCalls);
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
            });
        }

        yield* upsertCorrections(correctionBatch).pipe(
            Effect.withSpan("signals.write.corrections", {
                attributes: { "signals.count": correctionBatch.length },
            }),
        );
        // Denormalise was_corrected onto invoked edges so cmdTaste's
        // corrections subquery becomes a pure index/scan filter (issue #31).
        yield* markWasCorrected(correctionBatch).pipe(
            Effect.withSpan("signals.write.was-corrected", {
                attributes: { "signals.count": correctionBatch.length },
            }),
        );
        yield* upsertProposed(proposedBatch).pipe(
            Effect.withSpan("signals.write.proposed", {
                attributes: { "signals.count": proposedBatch.length },
            }),
        );
        if (shouldWriteSkillPairs) {
            yield* upsertSkillPairs(pairsList, pairEdgeIds).pipe(
                Effect.withSpan("signals.write.skill-pairs", {
                    attributes: { "signals.count": pairsList.length },
                }),
            );
        }
        yield* upsertRecovered(recoveryBatch).pipe(
            Effect.withSpan("signals.write.recovered", {
                attributes: { "signals.count": recoveryBatch.length },
            }),
        );
        yield* upsertFrictionEvents(frictionBatch).pipe(
            Effect.withSpan("signals.write.friction", {
                attributes: { "signals.count": frictionBatch.length },
            }),
        );
        yield* upsertDiagnosticEvents(diagnosticBatch).pipe(
            Effect.withSpan("signals.write.diagnostics", {
                attributes: { "signals.count": diagnosticBatch.length },
            }),
        );

        yield* Effect.logDebug("signals derived", {
            sessions: bundles.length,
            turns: turnCount,
            corrections,
            proposed,
            skillPairs: pairsList.length,
            recoveries,
            frictionEvents: frictionBatch.length,
            diagnosticEvents: diagnosticBatch.length,
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

// ---------------------------------------------------------------------------
// Co-located StageDef
// ---------------------------------------------------------------------------

import { BaseStageStats, IngestContext, sinceAndClause, sinceDaysFromCtx, sinceWhereClause, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";

export const SignalsKey = Schema.Literal("signals");
export type SignalsKey = typeof SignalsKey.Type;

/**
 * Signals stage - derives Friction/Feedback/Diagnostic/Intent edges from
 * Tool Calls + Turns. Depends on {@link ClaudeKey}, {@link CodexKey},
 * {@link SubagentsKey}, {@link SpawnedKey}, {@link GitKey}.
 * Consumed by {@link OutcomesKey}, {@link SessionHealthKey}, {@link ClosureKey}.
 */
export class SignalsStats extends BaseStageStats.extend<SignalsStats>("SignalsStats")({
    frictionEvents: Schema.Number,
    diagnosticEvents: Schema.Number,
    corrections: Schema.Number,
    proposed: Schema.Number,
}) {}

export const signalsStage: StageDef<SignalsStats, SurrealClient> = {
    meta: StageMeta.make({ key: "signals", deps: ["claude", "codex", "pi", "opencode", "cursor", "subagents", "spawned", "git"], tags: ["derive"] }),
    run: (ctx: IngestContext) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const sinceDays = sinceDaysFromCtx(ctx);
            const result = yield* deriveSignals({ sinceDays });
            return SignalsStats.make({
                durationMs: Date.now() - t0,
                summary: `derived ${result.frictionEvents} friction, ${result.diagnosticEvents} diagnostic events`,
                frictionEvents: result.frictionEvents,
                diagnosticEvents: result.diagnosticEvents,
                corrections: result.corrections,
                proposed: result.proposed,
            });
        }),
};
