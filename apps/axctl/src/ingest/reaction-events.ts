import { Effect, Schema } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { recordKeyPart, safeKeyPart } from "@ax/lib/shared/derive-keys";
import { executeStatementsWith } from "@ax/lib/shared/statement-exec";
import {
    recordRef,
    surrealDate,
    surrealJsonTextOption,
    surrealObject,
    surrealOptionRecord,
    surrealOptionString,
    surrealString,
} from "@ax/lib/shared/surql";
import { BaseStageStats, IngestContext, sinceDaysFromCtx, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";

export const ReactionEventsKey = Schema.Literal("reaction-events");
export type ReactionEventsKey = typeof ReactionEventsKey.Type;

export type ReactionType =
    | "approval"
    | "correction"
    | "direction"
    | "scope_adjustment"
    | "clarification"
    | "rejection"
    | "continuation"
    | "meta_question";
export type ReactionTarget =
    | "environment_setup"
    | "prototype_completeness"
    | "verification"
    | "wrong_scope"
    | "wrong_output"
    | "implementation_choice"
    | "communication"
    | "unknown";
export type ReactionDurability = "one_off" | "session_preference" | "repo_preference" | "global_preference";
export type ReactionPolarity = "accept" | "reject" | "revise" | "explore" | "none";

export interface ReactionEventInput {
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

export interface ReactionContext {
    readonly previousAssistantText: string | null;
    readonly recentToolFailureText: string | null;
}

export interface ReactionEventWrite {
    readonly key: string;
    readonly userTurnKey: string;
    readonly assistantTurnKey: string | null;
    readonly sessionKey: string | null;
    readonly reactionType: ReactionType;
    readonly target: ReactionTarget;
    readonly polarity: ReactionPolarity;
    readonly durability: ReactionDurability;
    readonly confidence: number;
    readonly method: "heuristic";
    readonly signals: readonly string[];
    readonly userText: string;
    readonly assistantText: string | null;
    readonly context: ReactionContext;
    readonly ts: string | Date;
}

export interface ReactionEventsStats {
    readonly events: number;
    readonly directions: number;
    readonly corrections: number;
    readonly clusters: number;
}

const textOf = (row: ReactionEventInput): string =>
    (row.text_excerpt ?? row.text ?? "").trim();

const isAssistant = (row: ReactionEventInput): boolean =>
    row.role === "assistant" || row.message_kind === "assistant";

const isUser = (row: ReactionEventInput): boolean =>
    row.role === "user" && row.message_kind !== "system_or_developer";

const isWrapperOrContextText = (text: string): boolean =>
    text.startsWith("<goal_context>") ||
    text.startsWith("# AGENTS.md instructions") ||
    text.startsWith("# CLAUDE.md") ||
    text.includes("<INSTRUCTIONS>") ||
    text.includes("<environment_context>") ||
    text.startsWith("<task>") ||
    text.startsWith("<task-notification>");

const isToolFailure = (row: ReactionEventInput, text: string): boolean =>
    row.role === "tool" ||
    row.role === "tool_result" ||
    row.message_kind === "tool_result"
        ? /\b(error|failed|failure|exception|traceback|permission denied|not found|dependency|exit code)\b/i.test(text)
        : false;

const clamp = (value: number): number =>
    Math.max(0, Math.min(1, Number(value.toFixed(2))));

// The reaction_event record id is keyed by user_turn ALONE. The schema enforces
// one reaction_event per user_turn (UNIQUE index reaction_event_user_turn), so
// the id must be a stable function of user_turn for the UPSERT to be idempotent.
// Folding assistantTurnKey/hash into the id (as before) made `--since N` runs
// derive a DIFFERENT id for the same user_turn whenever the windowed fetch saw a
// different "previous assistant", producing a second record and a unique-index
// violation that aborted the whole ingest. assistantTurnKey is still stored as
// the assistant_turn field; it just doesn't belong in the primary key.
const eventKey = (userTurnKey: string): string => safeKeyPart(userTurnKey);

const baseEvent = (
    row: ReactionEventInput,
    previousAssistant: { readonly key: string; readonly text: string } | null,
    recentToolFailureText: string | null,
    patch: Omit<ReactionEventWrite, "key" | "userTurnKey" | "assistantTurnKey" | "sessionKey" | "method" | "userText" | "assistantText" | "context" | "ts">,
): ReactionEventWrite => {
    const userTurnKey = recordKeyPart(row.id, "turn") ?? String(row.id);
    const assistantTurnKey = previousAssistant?.key ?? null;
    return {
        ...patch,
        key: eventKey(userTurnKey),
        userTurnKey,
        assistantTurnKey,
        sessionKey: recordKeyPart(row.session, "session"),
        method: "heuristic",
        userText: textOf(row),
        assistantText: previousAssistant?.text ?? null,
        context: {
            previousAssistantText: previousAssistant?.text ?? null,
            recentToolFailureText,
        },
        ts: row.ts,
    };
};

function classifyReactionEvent(
    row: ReactionEventInput,
    previousAssistant: { readonly key: string; readonly text: string } | null,
    recentToolFailureText: string | null,
): ReactionEventWrite | null {
    const text = textOf(row);
    if (text.length === 0) return null;
    if (isWrapperOrContextText(text)) return null;
    const lower = text.toLowerCase();
    const signals: string[] = [];
    if (recentToolFailureText) signals.push("context:recent_tool_failure");

    if (/\buv\b|\buse uv\b|\bcan you use uv\b|\buse bun\b|\bdon'?t use npm\b|\bdon'?t use pip\b/i.test(lower)) {
        if (/\buv\b/i.test(lower)) signals.push("tooling:uv");
        if (/\bbun\b/i.test(lower)) signals.push("tooling:bun");
        signals.push("target:environment_setup");
        return baseEvent(row, previousAssistant, recentToolFailureText, {
            reactionType: "direction",
            target: "environment_setup",
            polarity: "revise",
            durability: "repo_preference",
            confidence: clamp(recentToolFailureText ? 0.9 : 0.82),
            signals,
        });
    }

    if (/\b(not just html|dont want just html|don't want just html|want to see the results|working classifier|apply to surrealml)\b/i.test(lower)) {
        signals.push("prototype:not_just_html", "target:prototype_completeness");
        return baseEvent(row, previousAssistant, recentToolFailureText, {
            reactionType: "correction",
            target: "prototype_completeness",
            polarity: "revise",
            durability: "repo_preference",
            confidence: 0.88,
            signals,
        });
    }

    if (/\b(test|verify|show output|prove|did you run)\b/i.test(lower)) {
        signals.push("target:verification");
        return baseEvent(row, previousAssistant, recentToolFailureText, {
            reactionType: "direction",
            target: "verification",
            polarity: "revise",
            durability: "session_preference",
            confidence: 0.78,
            signals,
        });
    }

    if (/^(no|nope|nah)\b|\b(wrong|not what i asked|not that|instead|rather)\b/i.test(lower)) {
        signals.push("target:wrong_output");
        return baseEvent(row, previousAssistant, recentToolFailureText, {
            reactionType: "correction",
            target: "wrong_output",
            polarity: "revise",
            durability: "session_preference",
            confidence: 0.76,
            signals,
        });
    }

    if (/^(yes|yeah|yep|exactly|correct|works|ship)\b/i.test(lower)) {
        signals.push("feedback:approval");
        return baseEvent(row, previousAssistant, recentToolFailureText, {
            reactionType: "approval",
            target: "unknown",
            polarity: "accept",
            durability: "one_off",
            confidence: 0.82,
            signals,
        });
    }

    return null;
}

export function deriveReactionEvents(rows: readonly ReactionEventInput[]): ReactionEventWrite[] {
    const previousAssistantBySession = new Map<string, { key: string; text: string }>();
    const recentToolFailureBySession = new Map<string, string>();
    const events: ReactionEventWrite[] = [];

    for (const row of rows) {
        const sessionKey = recordKeyPart(row.session, "session") ?? "unknown";
        const text = textOf(row);
        if (isAssistant(row)) {
            previousAssistantBySession.set(sessionKey, {
                key: recordKeyPart(row.id, "turn") ?? String(row.id),
                text,
            });
            continue;
        }
        if (isToolFailure(row, text)) {
            recentToolFailureBySession.set(sessionKey, text.slice(0, 1000));
            continue;
        }
        if (!isUser(row)) continue;
        const event = classifyReactionEvent(
            row,
            previousAssistantBySession.get(sessionKey) ?? null,
            recentToolFailureBySession.get(sessionKey) ?? null,
        );
        if (event) events.push(event);
    }

    return events;
}

const buildReactionEventStatement = (event: ReactionEventWrite): string =>
    `UPSERT ${recordRef("reaction_event", event.key)} CONTENT ${surrealObject([
        ["user_turn", recordRef("turn", event.userTurnKey)],
        ["assistant_turn", surrealOptionRecord("turn", event.assistantTurnKey)],
        ["session", surrealOptionRecord("session", event.sessionKey)],
        ["reaction_type", surrealString(event.reactionType)],
        ["target", surrealString(event.target)],
        ["polarity", surrealString(event.polarity)],
        ["durability", surrealString(event.durability)],
        ["confidence", event.confidence.toString()],
        ["method", surrealString(event.method)],
        ["signals", surrealJsonTextOption(event.signals)],
        ["user_text", surrealOptionString(event.userText)],
        ["assistant_text", surrealOptionString(event.assistantText)],
        ["context_json", surrealJsonTextOption(event.context)],
        ["ts", surrealDate(event.ts)],
        ["updated_at", "time::now()"],
    ])};`;

export const buildReactionEventStatements = (
    events: readonly ReactionEventWrite[],
): string[] => events.map(buildReactionEventStatement);

const REACTION_DELETE_CHUNK = 200;

/**
 * Scoped deletes for an incremental re-derive: clear every reaction_event whose
 * `user_turn` is in the batch we're about to rewrite. Matching on the field
 * (not the record id) clears rows written under the OLD composite-id scheme
 * (user_turn__assistant_turn__hash) that still occupy the same user_turn under
 * the UNIQUE index - otherwise the fresh user_turn-keyed UPSERT collides with
 * them. Chunked so the IN-list stays a reasonable statement size.
 */
export const buildReactionEventDeleteStatements = (
    events: readonly ReactionEventWrite[],
): string[] => {
    const userTurns = [...new Set(events.map((event) => event.userTurnKey))];
    const statements: string[] = [];
    for (let i = 0; i < userTurns.length; i += REACTION_DELETE_CHUNK) {
        const refs = userTurns
            .slice(i, i + REACTION_DELETE_CHUNK)
            .map((key) => recordRef("turn", key))
            .join(", ");
        statements.push(`DELETE reaction_event WHERE user_turn IN [${refs}];`);
    }
    return statements;
};

const fetchTurns = (sinceDays: number | undefined): Effect.Effect<ReactionEventInput[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const since = sinceDays && sinceDays > 0 ? `WHERE ts > time::now() - ${sinceDays}d` : "";
        const [rows] = yield* db.query<[ReactionEventInput[]]>(`
SELECT id, session, session.source AS source, seq, role, message_kind, intent_kind, text, text_excerpt, type::string(ts) AS ts
FROM turn
${since}
ORDER BY session, seq;`);
        return rows ?? [];
    });

export const deriveReactionEventRows = (
    opts: { readonly sinceDays: number | undefined } = { sinceDays: undefined },
): Effect.Effect<ReactionEventsStats, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const rows = yield* fetchTurns(opts.sinceDays);
        const events = deriveReactionEvents(rows);
        if (opts.sinceDays === undefined) {
            // Full re-derive: wipe and rebuild.
            yield* db.query("DELETE reaction_event;");
        } else if (events.length > 0) {
            // Incremental: delete the reaction_events for just the user_turns we
            // re-derive (idempotent + self-heals legacy composite-id rows).
            yield* executeStatementsWith(db, buildReactionEventDeleteStatements(events), { chunkSize: 50 });
        }
        yield* executeStatementsWith(db, buildReactionEventStatements(events), { chunkSize: 500 });
        const clusters = new Set(events.map((event) =>
            `${event.reactionType}:${event.target}:${event.durability}`,
        )).size;
        return {
            events: events.length,
            directions: events.filter((event) => event.reactionType === "direction").length,
            corrections: events.filter((event) => event.reactionType === "correction").length,
            clusters,
        };
    });

export class ReactionEventsStageStats extends BaseStageStats.extend<ReactionEventsStageStats>("ReactionEventsStageStats")({
    events: Schema.Number,
    directions: Schema.Number,
    corrections: Schema.Number,
    clusters: Schema.Number,
}) {}

export const reactionEventsStage: StageDef<ReactionEventsStageStats, SurrealClient> = {
    meta: StageMeta.make({ key: "reaction-events", deps: ["turn-analysis"], tags: ["derive"] }),
    run: (ctx: IngestContext) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const result = yield* deriveReactionEventRows({ sinceDays: sinceDaysFromCtx(ctx) });
            return ReactionEventsStageStats.make({
                durationMs: Date.now() - t0,
                summary: `derived ${result.events} context-aware reaction events across ${result.clusters} clusters`,
                ...result,
            });
        }),
};
