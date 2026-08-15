import { Effect, Schema } from "effect";
import { CORRECTION_MAX_LENGTH, isCorrectionPhrase } from "@ax/lib/shared/correction-phrase";
import { TimestampColumn } from "@ax/lib/duckdb/columns";
import { cacheRow, jsonParam, tsParam } from "@ax/lib/duckdb/row";
import type { CacheReadError, CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import { stableId } from "@ax/lib/stable-id";
import { classifyFeedback, classifyUserAsk } from "./ask-outcome.ts";
import { BaseStageStats, IngestContext, sinceDaysFromCtx, StageMeta } from "./stage/types.ts";
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
    readonly id: string;
    readonly session: string;
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
    stableId("semantic_signal", [kind, label]);

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
    // Plural/inflected forms kept (run the tests, make sure the checks pass).
    if (ask === "verification_request" || /\b(verif(?:y|ies)|tests?|typechecks?|lint|checks?)\b/i.test(lower)) {
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
    const turnKey = row.id;
    const sessionKey = row.session;
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

const analysisRecordKey = (turnKey: string): string => stableId("turn_analysis", [turnKey]);
const expressesRecordKey = (turnKey: string, signalKey: string): string =>
    stableId("expresses", [turnKey, signalKey]);
const reactsToRecordKey = (fromTurnKey: string, toTurnKey: string): string =>
    stableId("reacts_to", [fromTurnKey, toTurnKey]);

export const buildTurnAnalysisRows = (
    analyses: readonly TurnAnalysisWrite[],
) => {
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
    return {
        analyses: analyses.map((analysis) => cacheRow({
            id: analysisRecordKey(analysis.turnKey), turn: analysis.turnKey, session: analysis.sessionKey,
            speaker: analysis.speaker, act: analysis.act, sentiment: analysis.sentiment,
            polarity: analysis.polarity, confidence: analysis.confidence, method: analysis.method,
            signals: jsonParam(analysis.signals), text: analysis.text, ts: tsParam(analysis.ts), updated_at: new Date(),
        })),
        signals: [...signals.values()].map((signalWrite) => cacheRow({
            id: signalWrite.key, kind: signalWrite.kind, label: signalWrite.label,
            canonical_text: signalWrite.canonicalText, description: signalWrite.description ?? null,
            method: "heuristic", confidence: signalWrite.confidence,
            first_seen: tsParam(signalWrite.firstSeen ?? signalWrite.ts),
            last_seen: tsParam(signalWrite.lastSeen ?? signalWrite.ts), metrics: jsonParam({ source: "turn_analysis" }),
        })),
        expresses: analyses.filter((analysis) => analysis.semanticSignal !== null).map((analysis) => cacheRow({
            id: expressesRecordKey(analysis.turnKey, analysis.semanticSignal!.key), in_id: analysis.turnKey,
            out_id: analysis.semanticSignal!.key, analysis: analysisRecordKey(analysis.turnKey),
            session: analysis.sessionKey, confidence: analysis.confidence, method: analysis.method, ts: tsParam(analysis.ts),
        })),
        reactsTo: analyses.filter((analysis) => analysis.reactsToTurnKey !== null).map((analysis) => cacheRow({
            id: reactsToRecordKey(analysis.turnKey, analysis.reactsToTurnKey!), in_id: analysis.turnKey,
            out_id: analysis.reactsToTurnKey!, session: analysis.sessionKey, polarity: analysis.polarity,
            act: analysis.act, confidence: analysis.confidence, signal: analysis.semanticSignal?.key ?? null,
            ts: tsParam(analysis.ts),
        })),
    };
};

export function deriveTurnAnalysisRows(rows: readonly TurnAnalysisInput[]): TurnAnalysisWrite[] {
    const previousAssistantBySession = new Map<string, string>();
    return rows.map((row) => {
        const sessionKey = row.session;
        const previousAssistantTurnKey = previousAssistantBySession.get(sessionKey) ?? null;
        const analysis = classifyTurnAnalysis(row, previousAssistantTurnKey);
        if (analysis.speaker === "assistant") previousAssistantBySession.set(sessionKey, analysis.turnKey);
        return analysis;
    });
}

const fetchTurns = (write: CacheWriteService, sinceDays: number | undefined): Effect.Effect<readonly TurnAnalysisInput[], CacheReadError> =>
    Effect.gen(function* () {
        return yield* write.rows(Schema.Struct({
            id: Schema.String, session: Schema.String, seq: Schema.Number, role: Schema.String,
            source: Schema.NullOr(Schema.String), message_kind: Schema.NullOr(Schema.String),
            intent_kind: Schema.NullOr(Schema.String), text: Schema.NullOr(Schema.String),
            text_excerpt: Schema.NullOr(Schema.String), ts: TimestampColumn,
        }), `SELECT t.id, t.session, CAST(t.seq AS DOUBLE) AS seq, t.role, s.source,
                    t.message_kind, t.intent_kind, t.text, t.text_excerpt, t.ts
             FROM turn t JOIN session s ON s.id = t.session
             ${sinceDays === undefined ? "" : "WHERE t.ts >= current_timestamp - (? * INTERVAL '1 day')"}
             ORDER BY t.session, t.seq`, sinceDays === undefined ? [] : [sinceDays]);
    });

/**
 * Load the set of turn keys that already have a `turn_analysis` row. Uses the
 * UNIQUE `turn_analysis_turn` index (single field `turn`), so this is a fast
 * indexed read of just the foreign keys, not a full-row scan. The returned keys
 * are normalized through `recordKeyPart(..., "turn")` so they line up exactly
 * with the `turnKey` produced by `classifyTurnAnalysis`.
 */
const loadAnalyzedTurnKeys = (write: CacheWriteService): Effect.Effect<Set<string>, CacheReadError> =>
    Effect.gen(function* () {
        const rows = yield* write.rows(Schema.Struct({ turn: Schema.String }), "SELECT turn FROM turn_analysis");
        const set = new Set<string>();
        for (const row of rows) set.add(row.turn);
        return set;
    });

const persistTurnAnalysisRows = (write: CacheWriteService, analyses: readonly TurnAnalysisWrite[]) =>
    Effect.gen(function* () {
        const rows = buildTurnAnalysisRows(analyses);
        yield* write.putMany("turn_analysis", rows.analyses);
        yield* write.putMany("semantic_signal", rows.signals);
        yield* write.putMany("expresses", rows.expresses);
        yield* write.putMany("reacts_to", rows.reactsTo);
    });

export const deriveTurnAnalysis = (
    write: CacheWriteService,
    opts: { readonly sinceDays: number | undefined } = { sinceDays: undefined },
): Effect.Effect<TurnAnalysisStats, CacheReadError | CacheWriteError> =>
    Effect.gen(function* () {
        // Escape hatch: when the derivation logic itself changes, force a full
        // reset + re-derive of every turn analysis.
        const full = process.env.AX_REDERIVE_ANALYSIS === "1";
        const rows = yield* fetchTurns(write, opts.sinceDays);
        // Derive over the full ordered row set so the reacts_to "previous
        // assistant turn" lookahead has complete session context, then filter
        // down to only the turns that still need persisting.
        const allAnalyses = deriveTurnAnalysisRows(rows);

        if (full && opts.sinceDays === undefined) {
            for (const table of ["reacts_to", "expresses", "turn_analysis", "semantic_signal"]) yield* write.exec(`DELETE FROM ${table}`);
            yield* persistTurnAnalysisRows(write, allAnalyses);
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
        const analyzed = yield* loadAnalyzedTurnKeys(write);
        const analyses = allAnalyses.filter((a) => !analyzed.has(a.turnKey));
        yield* persistTurnAnalysisRows(write, analyses);
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

export const turnAnalysisStage: StageDef<TurnAnalysisStageStats, never, import("./stage/registry.ts").IngestStageError> = {
    meta: StageMeta.make({ key: "turn-analysis", deps: ["outcomes"], tags: ["derive"] }),
    run: (ctx: IngestContext, write) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const result = yield* deriveTurnAnalysis(write, { sinceDays: sinceDaysFromCtx(ctx) });
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
