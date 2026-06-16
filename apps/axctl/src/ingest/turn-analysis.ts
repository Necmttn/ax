import { Effect, Schema } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { CORRECTION_MAX_LENGTH, isCorrectionPhrase } from "@ax/lib/shared/correction-phrase";
import { recordKeyPart, safeKeyPart } from "@ax/lib/shared/derive-keys";
import { executeStatementsWith } from "@ax/lib/shared/statement-exec";
import {
    recordRef,
    surrealDate,
    surrealJsonTextOption,
    surrealObject,
    surrealOptionRecord,
    surrealOptionString,
    surrealRecordKey,
    surrealString,
} from "@ax/lib/shared/surql";
import { classifyFeedback, classifyUserAsk } from "./ask-outcome.ts";
import { BaseStageStats, IngestContext, sinceDaysFromCtx, sinceWhereClause, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";

export const TurnAnalysisKey = Schema.Literal("turn-analysis");
export type TurnAnalysisKey = typeof TurnAnalysisKey.Type;

export type TurnSpeaker = "user" | "assistant" | "tool";
export type TurnAnalysisAct =
    | "request"
    | "correction"
    | "approval"
    | "rejection"
    | "clarification"
    | "exploration"
    | "status_update"
    | "implementation"
    | "verification"
    | "blocker"
    | "handoff"
    | "tool_result"
    | "other";
export type TurnAnalysisSentiment = "positive" | "neutral" | "negative" | "mixed" | "unknown";
export type TurnAnalysisPolarity = "accept" | "reject" | "revise" | "explore" | "none";

export interface TurnAnalysisInput {
    readonly id: unknown;
    readonly session: unknown;
    readonly seq: number;
    readonly role: string;
    readonly source?: string | null;
    readonly message_kind?: string | null;
    readonly intent_kind?: string | null;
    readonly text?: string | null;
    readonly text_excerpt?: string | null;
    readonly ts: string | Date;
}

export interface SemanticSignalWrite {
    readonly key: string;
    readonly kind: string;
    readonly label: string;
    readonly canonicalText: string;
    readonly description?: string | null;
    readonly confidence: number;
    readonly ts: string | Date;
    readonly firstSeen?: string | Date;
    readonly lastSeen?: string | Date;
}

export interface TurnAnalysisWrite {
    readonly turnKey: string;
    readonly sessionKey: string | null;
    readonly speaker: TurnSpeaker;
    readonly act: TurnAnalysisAct;
    readonly sentiment: TurnAnalysisSentiment;
    readonly polarity: TurnAnalysisPolarity;
    readonly confidence: number;
    readonly method: "heuristic";
    readonly signals: readonly string[];
    readonly text: string | null;
    readonly ts: string | Date;
    readonly semanticSignal: SemanticSignalWrite | null;
    readonly reactsToTurnKey: string | null;
}

export interface TurnAnalysisStats {
    readonly turnsAnalyzed: number;
    readonly signalsPromoted: number;
    readonly expressesEdges: number;
    readonly reactsToEdges: number;
}

const normalizedText = (input: TurnAnalysisInput): string =>
    (input.text_excerpt ?? input.text ?? "").trim();

const isWrapperOrContextText = (row: TurnAnalysisInput, text: string): boolean => {
    const kind = row.message_kind ?? "";
    if (row.source === "claude-subagent") return true;
    if (kind === "context" || kind === "system_or_developer") return true;
    return text.startsWith("# AGENTS.md instructions") ||
        text.startsWith("# CLAUDE.md") ||
        text.startsWith("<skill>") ||
        text.includes("<INSTRUCTIONS>") ||
        text.includes("SKILL.md") ||
        text.includes("<environment_context>") ||
        text.startsWith("<subagent_notification>") ||
        text.startsWith("<task>") ||
        text.startsWith("<task-notification>") ||
        /^review\b|^diagnostic review\b|^code reuse review\b|^code quality review\b|^spec compliance review\b|^final re-review\b|^re-review\b/i.test(text) ||
        /\bdo not edit files\b/i.test(text);
};

const speakerFor = (row: TurnAnalysisInput): TurnSpeaker => {
    if (row.role === "assistant" || row.message_kind === "assistant") return "assistant";
    if (row.role === "tool" || row.role === "tool_result" || row.message_kind === "tool_result") return "tool";
    return "user";
};

const clampConfidence = (value: number): number =>
    Math.max(0, Math.min(1, Number(value.toFixed(2))));

export const semanticSignalKey = (kind: string, label: string): string =>
    `${safeKeyPart(kind)}__${safeKeyPart(label)}`;

const signal = (
    kind: string,
    label: string,
    canonicalText: string,
    confidence: number,
    ts: string | Date,
    description?: string,
): SemanticSignalWrite => {
    const write: SemanticSignalWrite = {
        key: semanticSignalKey(kind, label),
        kind,
        label,
        canonicalText,
        confidence: clampConfidence(confidence),
        ts,
    };
    return description === undefined ? write : { ...write, description };
};

const correctionSignal = (text: string, ts: string | Date): SemanticSignalWrite => {
    if (/\bwrong file|wrong route|wrong target|not that file|not that route\b/i.test(text)) {
        return signal("correction", "wrong_target", "User says the agent targeted the wrong file, route, or object.", 0.9, ts);
    }
    if (/\b(spec|code quality|review)\s+requested\b.*\bfix\b/i.test(text) || /^finding:/i.test(text)) {
        return signal("correction", "review_fix_request", "Review feedback requests a concrete fix after an attempted implementation.", 0.86, ts);
    }
    if (/\b(no link|missing link|not linked|doesn'?t link|link from|navigation)\b/i.test(text)) {
        return signal("correction", "missing_link_or_navigation", "User points out missing navigation, linking, or discoverability.", 0.84, ts);
    }
    if (/\b(too complex|too complicated|unnecessarily complex|unnecessarilly complex|too much going on|hard to digest|simpler|clean simple)\b/i.test(text)) {
        return signal("correction", "simplify_output", "User asks for simpler wording, presentation, or information architecture.", 0.84, ts);
    }
    if (/\b(when i said|i meant|i was talking about|are you sure|as far as i know|actually using|i thought you)\b/i.test(text)) {
        return signal("correction", "factual_clarification", "User corrects the agent's understanding of facts, references, or intended target.", 0.84, ts);
    }
    if (/\b(feel native|native|curve|stretch|overlap|visual clues?|more visual|easy to understand|realistic complete demo|teleprompter|fastpaced|typewriter|motion)\b/i.test(text)) {
        return signal("correction", "ux_polish_direction", "User redirects interaction, motion, or visual polish toward a better experience.", 0.82, ts);
    }
    if (/\b(t\+7|t\+30|t\+90|too long|shorter iterations?|cadence|faster iterations?)\b/i.test(text)) {
        return signal("correction", "iteration_cadence", "User says the proposed timing or iteration cycle is too slow or too long.", 0.82, ts);
    }
    if (/\b(skill that you can run|can run review all|can run|existing functionality|do we actually have|functionality|functionalities)\b/i.test(text)) {
        return signal("correction", "capability_correction", "User corrects what the agent can do or what functionality already exists.", 0.82, ts);
    }
    if (/\b(hold|drag|release|drop|button|pressed|press|autoplay|interact|tabs?|click|navigate)\b/i.test(text)) {
        return signal("correction", "interaction_pattern", "User corrects the expected interaction mechanics or navigation behavior.", 0.82, ts);
    }
    if (/\b(migrations?|from scratch|typed|type-safe|modular|effect\.?ts|e2e|end-to-end|source-of-truth|no need to keep|app is not live)\b/i.test(text)) {
        return signal("correction", "implementation_preference", "User states an implementation preference or engineering constraint.", 0.82, ts);
    }
    if (/\b(backend is down|server down|no tabs|login did work|screen actually work|feature ready|works? wrong|doesn'?t work)\b/i.test(text)) {
        return signal("correction", "runtime_state_correction", "User corrects the agent about current runtime, app, or environment state.", 0.82, ts);
    }
    if (/\b(landing|prototype|showcase|demo|framework agnostic|functionalities|hint|graph|metrics|content)\b/i.test(text)) {
        return signal("correction", "product_content_direction", "User redirects product content, demo framing, or feature positioning.", 0.8, ts);
    }
    if (/^(stop|don'?t|do not|no more)\b/i.test(text) ||
        /\b(stop|don'?t|do not)\s+(doing|use|add|build|create|write|edit|touch|mock|change|revert)\b/i.test(text)) {
        return signal("correction", "stop_doing", "User tells the agent to stop a behavior.", 0.86, ts);
    }
    if (/\binstead\b|\brather\b|\bmore like\b/i.test(text)) {
        return signal("correction", "revise_direction", "User redirects the agent toward a different approach.", 0.82, ts);
    }
    return signal("correction", "generic_correction", "User corrects or revises the assistant.", 0.74, ts);
};

function classifyUserTurn(row: TurnAnalysisInput): Omit<TurnAnalysisWrite, "turnKey" | "sessionKey" | "reactsToTurnKey"> {
    const text = normalizedText(row);
    const lower = text.toLowerCase();
    if (isWrapperOrContextText(row, text)) {
        return {
            speaker: "user",
            act: "other",
            sentiment: "neutral",
            polarity: "none",
            confidence: 0.88,
            method: "heuristic",
            signals: ["wrapper_or_context"],
            text,
            ts: row.ts,
            semanticSignal: null,
        };
    }
    const feedback = classifyFeedback(text);
    const ask = classifyUserAsk(text);
    const isCorrection = text.length < CORRECTION_MAX_LENGTH &&
        (isCorrectionPhrase(text) || feedback === "correction" || row.intent_kind === "correction");

    if (isCorrection) {
        const semanticSignal = correctionSignal(text, row.ts);
        return {
            speaker: "user",
            act: "correction",
            sentiment: "negative",
            polarity: "revise",
            confidence: Math.max(0.78, semanticSignal.confidence),
            method: "heuristic",
            signals: ["intent:correction", `signal:${semanticSignal.label}`],
            text,
            ts: row.ts,
            semanticSignal,
        };
    }

    if (feedback === "approval") {
        return {
            speaker: "user",
            act: "approval",
            sentiment: "positive",
            polarity: "accept",
            confidence: 0.92,
            method: "heuristic",
            signals: ["feedback:approval"],
            text,
            ts: row.ts,
            semanticSignal: signal("feedback", "approval", "User approves or confirms the assistant output.", 0.92, row.ts),
        };
    }

    if (feedback === "friction") {
        return {
            speaker: "user",
            act: "rejection",
            sentiment: "negative",
            polarity: "reject",
            confidence: 0.82,
            method: "heuristic",
            signals: ["feedback:friction"],
            text,
            ts: row.ts,
            semanticSignal: signal("feedback", "user_friction", "User expresses frustration or rejection.", 0.82, row.ts),
        };
    }

    if (feedback === "exploration" || ask === "product_brainstorm") {
        return {
            speaker: "user",
            act: "exploration",
            sentiment: "neutral",
            polarity: "explore",
            confidence: 0.76,
            method: "heuristic",
            signals: ["feedback:exploration"],
            text,
            ts: row.ts,
            semanticSignal: signal("feedback", "exploration", "User explores a possible direction or product idea.", 0.76, row.ts),
        };
    }

    if (feedback === "uncertainty") {
        return {
            speaker: "user",
            act: "clarification",
            sentiment: "mixed",
            polarity: "explore",
            confidence: 0.72,
            method: "heuristic",
            signals: ["feedback:uncertainty"],
            text,
            ts: row.ts,
            semanticSignal: signal("feedback", "uncertainty", "User expresses uncertainty or asks for clarification.", 0.72, row.ts),
        };
    }

    // Grouped boundaries: the old ungrouped /\bverify|test|.../ matched "test"
    // inside "fastest"/"latest", "lint" inside any word, etc. (issue #471).
    if (ask === "verification_request" || /\b(verify|test|typecheck|lint|check)\b/i.test(lower)) {
        return {
            speaker: "user",
            act: "request",
            sentiment: "neutral",
            polarity: "none",
            confidence: 0.74,
            method: "heuristic",
            signals: ["ask:verification_request"],
            text,
            ts: row.ts,
            semanticSignal: signal("ask", "needs_verification", "User asks for verification or proof.", 0.74, row.ts),
        };
    }

    return {
        speaker: "user",
        act: "request",
        sentiment: "neutral",
        polarity: "none",
        confidence: ask === "unknown" ? 0.42 : 0.65,
        method: "heuristic",
        signals: ask === "unknown" ? [] : [`ask:${ask}`],
        text,
        ts: row.ts,
        semanticSignal: ask === "unknown" ? null : signal("ask", ask, `User ask classified as ${ask}.`, 0.65, row.ts),
    };
}

function classifyAssistantTurn(row: TurnAnalysisInput): Omit<TurnAnalysisWrite, "turnKey" | "sessionKey" | "reactsToTurnKey"> {
    const text = normalizedText(row);
    const lower = text.toLowerCase();

    if (/\b(blocked|can't|cannot|unable|failed|error|permission denied|not found)\b/i.test(lower)) {
        return {
            speaker: "assistant",
            act: "blocker",
            sentiment: "negative",
            polarity: "none",
            confidence: 0.78,
            method: "heuristic",
            signals: ["assistant:blocker"],
            text,
            ts: row.ts,
            semanticSignal: signal("assistant_behavior", "agent_blocked", "Assistant reports a blocker, failure, or inability.", 0.78, row.ts),
        };
    }

    if (/\b(i['’]?m|i am|i['’]?ll|i will)\s+(checking|running|going to run|about to run)\b/i.test(lower) ||
        /\bnext i['’]?ll\s+(run|check|verify|test|typecheck|lint)\b/i.test(lower)) {
        return {
            speaker: "assistant",
            act: "verification",
            sentiment: "neutral",
            polarity: "none",
            confidence: 0.7,
            method: "heuristic",
            signals: ["assistant:verification_intent"],
            text,
            ts: row.ts,
            semanticSignal: signal("assistant_behavior", "verification_intent", "Assistant says it intends to verify, test, or inspect next.", 0.7, row.ts),
        };
    }

    if (/\b(verified|tested|passes|passed|typecheck passed|lint passed|checks passed|validation passed)\b/i.test(lower)) {
        return {
            speaker: "assistant",
            act: "verification",
            sentiment: "positive",
            polarity: "none",
            confidence: 0.74,
            method: "heuristic",
            signals: ["assistant:verification"],
            text,
            ts: row.ts,
            semanticSignal: signal("assistant_behavior", "verification_claim", "Assistant claims verification or test status.", 0.74, row.ts),
        };
    }

    if (/\b(implemented|added|updated|changed|fixed|wired|created|migrated)\b/i.test(lower)) {
        return {
            speaker: "assistant",
            act: "implementation",
            sentiment: "neutral",
            polarity: "none",
            confidence: 0.68,
            method: "heuristic",
            signals: ["assistant:implementation"],
            text,
            ts: row.ts,
            semanticSignal: signal("assistant_behavior", "implementation_update", "Assistant reports implementation work.", 0.68, row.ts),
        };
    }

    return {
        speaker: "assistant",
        act: "other",
        sentiment: "neutral",
        polarity: "none",
        confidence: 0.45,
        method: "heuristic",
        signals: [],
        text,
        ts: row.ts,
        semanticSignal: null,
    };
}

export function classifyTurnAnalysis(
    row: TurnAnalysisInput,
    previousAssistantTurnKey: string | null = null,
): TurnAnalysisWrite {
    const turnKey = recordKeyPart(row.id, "turn") ?? String(row.id);
    const sessionKey = recordKeyPart(row.session, "session");
    const speaker = speakerFor(row);
    const base = speaker === "user"
        ? classifyUserTurn(row)
        : speaker === "assistant"
            ? classifyAssistantTurn(row)
            : {
                speaker: "tool" as const,
                act: "tool_result" as const,
                sentiment: row.role === "tool_result" || row.message_kind === "tool_result" ? "neutral" as const : "unknown" as const,
                polarity: "none" as const,
                confidence: 0.55,
                method: "heuristic" as const,
                signals: [],
                text: normalizedText(row),
                ts: row.ts,
                semanticSignal: null,
            };

    const reactsToTurnKey = speaker === "user" &&
        (base.polarity === "accept" || base.polarity === "reject" || base.polarity === "revise")
        ? previousAssistantTurnKey
        : null;

    return {
        ...base,
        turnKey,
        sessionKey,
        reactsToTurnKey,
        confidence: clampConfidence(base.confidence),
    };
}

const analysisRecordKey = (turnKey: string): string => turnKey;
const expressesRecordKey = (turnKey: string, signalKey: string): string =>
    `${safeKeyPart(turnKey).slice(0, 80)}__${safeKeyPart(signalKey).slice(0, 80)}__${Bun.hash(`${turnKey}|${signalKey}`).toString(16).slice(0, 12)}`;
const reactsToRecordKey = (fromTurnKey: string, toTurnKey: string): string =>
    `${safeKeyPart(fromTurnKey).slice(0, 80)}__${safeKeyPart(toTurnKey).slice(0, 80)}__${Bun.hash(`${fromTurnKey}|${toTurnKey}`).toString(16).slice(0, 12)}`;

const buildTurnAnalysisStatement = (analysis: TurnAnalysisWrite): string =>
    `UPSERT ${recordRef("turn_analysis", analysisRecordKey(analysis.turnKey))} CONTENT ${surrealObject([
        ["turn", recordRef("turn", analysis.turnKey)],
        ["session", surrealOptionRecord("session", analysis.sessionKey)],
        ["speaker", surrealString(analysis.speaker)],
        ["act", surrealString(analysis.act)],
        ["sentiment", surrealString(analysis.sentiment)],
        ["polarity", surrealString(analysis.polarity)],
        ["confidence", analysis.confidence.toString()],
        ["method", surrealString(analysis.method)],
        ["signals", surrealJsonTextOption(analysis.signals)],
        ["text", surrealOptionString(analysis.text)],
        ["ts", surrealDate(analysis.ts)],
        ["updated_at", "time::now()"],
    ])};`;

const buildSemanticSignalStatement = (signalWrite: SemanticSignalWrite): string =>
    `UPSERT ${recordRef("semantic_signal", signalWrite.key)} MERGE ${surrealObject([
        ["kind", surrealString(signalWrite.kind)],
        ["label", surrealString(signalWrite.label)],
        ["canonical_text", surrealString(signalWrite.canonicalText)],
        ["description", surrealOptionString(signalWrite.description ?? null)],
        ["method", surrealString("heuristic")],
        ["confidence", signalWrite.confidence.toString()],
        ["first_seen", surrealDate(signalWrite.firstSeen ?? signalWrite.ts)],
        ["last_seen", surrealDate(signalWrite.lastSeen ?? signalWrite.ts)],
        ["metrics", surrealJsonTextOption({ source: "turn_analysis" })],
    ])};`;

const buildExpressesStatement = (analysis: TurnAnalysisWrite): string[] => {
    if (!analysis.semanticSignal) return [];
    const signalKey = analysis.semanticSignal.key;
    return [
        `RELATE ${recordRef("turn", analysis.turnKey)}->expresses:\`${surrealRecordKey(expressesRecordKey(analysis.turnKey, signalKey))}\`->${recordRef("semantic_signal", signalKey)} SET analysis = ${recordRef("turn_analysis", analysisRecordKey(analysis.turnKey))}, session = ${surrealOptionRecord("session", analysis.sessionKey)}, confidence = ${analysis.confidence}, method = ${surrealString(analysis.method)}, ts = ${surrealDate(analysis.ts)};`,
    ];
};

const buildReactsToStatement = (analysis: TurnAnalysisWrite): string[] => {
    if (!analysis.reactsToTurnKey) return [];
    return [
        `RELATE ${recordRef("turn", analysis.turnKey)}->reacts_to:\`${surrealRecordKey(reactsToRecordKey(analysis.turnKey, analysis.reactsToTurnKey))}\`->${recordRef("turn", analysis.reactsToTurnKey)} SET session = ${surrealOptionRecord("session", analysis.sessionKey)}, polarity = ${surrealString(analysis.polarity)}, act = ${surrealString(analysis.act)}, confidence = ${analysis.confidence}, signal = ${analysis.semanticSignal ? recordRef("semantic_signal", analysis.semanticSignal.key) : "NONE"}, ts = ${surrealDate(analysis.ts)};`,
    ];
};

export const buildTurnAnalysisStatements = (
    analyses: readonly TurnAnalysisWrite[],
): string[] => {
    const signals = new Map<string, SemanticSignalWrite>();
    for (const analysis of analyses) {
        if (!analysis.semanticSignal) continue;
        const existing = signals.get(analysis.semanticSignal.key);
        if (!existing) {
            signals.set(analysis.semanticSignal.key, {
                ...analysis.semanticSignal,
                firstSeen: analysis.semanticSignal.ts,
                lastSeen: analysis.semanticSignal.ts,
            });
            continue;
        }
        const firstSeen = new Date(existing.firstSeen ?? existing.ts).getTime() <= new Date(analysis.semanticSignal.ts).getTime()
            ? existing.firstSeen ?? existing.ts
            : analysis.semanticSignal.ts;
        const lastSeen = new Date(existing.lastSeen ?? existing.ts).getTime() >= new Date(analysis.semanticSignal.ts).getTime()
            ? existing.lastSeen ?? existing.ts
            : analysis.semanticSignal.ts;
        signals.set(analysis.semanticSignal.key, {
            ...existing,
            confidence: Math.max(existing.confidence, analysis.semanticSignal.confidence),
            firstSeen,
            lastSeen,
        });
    }
    return [
        ...analyses.map(buildTurnAnalysisStatement),
        ...[...signals.values()].map(buildSemanticSignalStatement),
        ...analyses.flatMap(buildExpressesStatement),
        ...analyses.flatMap(buildReactsToStatement),
    ];
};

export function deriveTurnAnalysisRows(rows: readonly TurnAnalysisInput[]): TurnAnalysisWrite[] {
    const previousAssistantBySession = new Map<string, string>();
    return rows.map((row) => {
        const sessionKey = recordKeyPart(row.session, "session") ?? "unknown";
        const previousAssistantTurnKey = previousAssistantBySession.get(sessionKey) ?? null;
        const analysis = classifyTurnAnalysis(row, previousAssistantTurnKey);
        if (analysis.speaker === "assistant") previousAssistantBySession.set(sessionKey, analysis.turnKey);
        return analysis;
    });
}

const fetchTurns = (sinceDays: number | undefined): Effect.Effect<TurnAnalysisInput[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const since = sinceWhereClause(sinceDays);
        const [rows] = yield* db.query<[TurnAnalysisInput[]]>(`
SELECT id, session, session.source AS source, seq, role, message_kind, intent_kind, text, text_excerpt, type::string(ts) AS ts
FROM turn
${since}
ORDER BY session, seq;`);
        return rows ?? [];
    });

interface ExistingAnalyzedTurnRow {
    readonly turn?: unknown;
}

/**
 * Load the set of turn keys that already have a `turn_analysis` row. Uses the
 * UNIQUE `turn_analysis_turn` index (single field `turn`), so this is a fast
 * indexed read of just the foreign keys, not a full-row scan. The returned keys
 * are normalized through `recordKeyPart(..., "turn")` so they line up exactly
 * with the `turnKey` produced by `classifyTurnAnalysis`.
 */
const loadAnalyzedTurnKeys = (): Effect.Effect<Set<string>, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const [rows] = yield* db.query<[ExistingAnalyzedTurnRow[]]>(
            "SELECT turn FROM turn_analysis;",
        );
        const set = new Set<string>();
        for (const row of rows ?? []) {
            const key = recordKeyPart(row.turn, "turn");
            if (key != null) set.add(key);
        }
        return set;
    });

export const deriveTurnAnalysis = (
    opts: { readonly sinceDays: number | undefined } = { sinceDays: undefined },
): Effect.Effect<TurnAnalysisStats, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        // Escape hatch: when the derivation logic itself changes, force a full
        // reset + re-derive of every turn analysis.
        const full = process.env.AX_REDERIVE_ANALYSIS === "1";
        const rows = yield* fetchTurns(opts.sinceDays);
        // Derive over the full ordered row set so the reacts_to "previous
        // assistant turn" lookahead has complete session context, then filter
        // down to only the turns that still need persisting.
        const allAnalyses = deriveTurnAnalysisRows(rows);

        if (full && opts.sinceDays === undefined) {
            yield* db.query("DELETE reacts_to; DELETE expresses; DELETE turn_analysis; DELETE semantic_signal;");
            yield* executeStatementsWith(db, buildTurnAnalysisStatements(allAnalyses), { chunkSize: 500 });
            return {
                turnsAnalyzed: allAnalyses.length,
                signalsPromoted: new Set(allAnalyses.map((a) => a.semanticSignal?.key).filter(Boolean)).size,
                expressesEdges: allAnalyses.filter((a) => a.semanticSignal !== null).length,
                reactsToEdges: allAnalyses.filter((a) => a.reactsToTurnKey !== null).length,
            };
        }

        // Incremental: turns are append-only, so an existing `turn_analysis`
        // row is output-equivalent (its turn text/role/kind never mutate, and
        // its reacts_to/expresses edges have deterministic ids). Skip those;
        // only derive turns not yet analyzed. No blanket DELETE - the
        // turn_analysis id is the turn key, so each UPSERT lands in place. This
        // is a near-no-op on warm runs where almost every turn already exists.
        const analyzed = yield* loadAnalyzedTurnKeys();
        const analyses = allAnalyses.filter((a) => !analyzed.has(a.turnKey));
        const statements = buildTurnAnalysisStatements(analyses);
        yield* executeStatementsWith(db, statements, { chunkSize: 500 });
        return {
            turnsAnalyzed: analyses.length,
            signalsPromoted: new Set(analyses.map((a) => a.semanticSignal?.key).filter(Boolean)).size,
            expressesEdges: analyses.filter((a) => a.semanticSignal !== null).length,
            reactsToEdges: analyses.filter((a) => a.reactsToTurnKey !== null).length,
        };
    });

export class TurnAnalysisStageStats extends BaseStageStats.extend<TurnAnalysisStageStats>("TurnAnalysisStageStats")({
    turnsAnalyzed: Schema.Number,
    signalsPromoted: Schema.Number,
    expressesEdges: Schema.Number,
    reactsToEdges: Schema.Number,
}) {}

export const turnAnalysisStage: StageDef<TurnAnalysisStageStats, SurrealClient> = {
    meta: StageMeta.make({ key: "turn-analysis", deps: ["outcomes"], tags: ["derive"] }),
    run: (ctx: IngestContext) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const result = yield* deriveTurnAnalysis({ sinceDays: sinceDaysFromCtx(ctx) });
            return TurnAnalysisStageStats.make({
                durationMs: Date.now() - t0,
                summary: `analyzed ${result.turnsAnalyzed} turns, promoted ${result.signalsPromoted} semantic signals`,
                turnsAnalyzed: result.turnsAnalyzed,
                signalsPromoted: result.signalsPromoted,
                expressesEdges: result.expressesEdges,
                reactsToEdges: result.reactsToEdges,
            });
        }),
};
