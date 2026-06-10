/**
 * Pure SurrealQL statement builders for the signals stage. The derivation
 * core (./core.ts) produces edge/event specs; this module turns each batch
 * into idempotent statements. RELATE with a deterministic edge record-id
 * overwrites in place on re-run (SurrealDB rejects UPSERT on RELATION
 * tables); friction/diagnostic events use UPSERT..MERGE on deterministic
 * keys. All text literals route through @ax/lib/shared/surql.
 */
import {
    recordRef,
    surrealDate,
    surrealJsonTextOption,
    surrealObject,
    surrealOptionRecord,
    surrealOptionString,
    surrealString,
} from "@ax/lib/shared/surql";
import type {
    CorrectionEdge,
    DerivedDiagnosticEvent,
    DerivedFrictionEvent,
    ProposedEdge,
    RecoveryEdge,
    SkillPairAccum,
} from "./types.ts";

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

export function recoveredByEdgeId(fromTurnKey: string, skillKey: string): string {
    return `${fromTurnKey}__${skillKey}`;
}

export const buildCorrectedByStatements = (edges: readonly CorrectionEdge[]): string[] =>
    edges.map((e) => {
        const edgeId = correctedByEdgeId(e.fromTurnKey, e.toTurnKey);
        return `RELATE turn:\`${e.fromTurnKey}\` -> corrected_by:\`${edgeId}\` -> turn:\`${e.toTurnKey}\` SET pattern = ${surrealString(e.pattern)}, ts = d"${e.ts}";`;
    });

/**
 * Expand correction edges into the turn keys whose `invoked` edges must be
 * marked `was_corrected = true`: every turn in `[correctedSeq - 3,
 * correctedSeq]` (inclusive both ends) of the corrected session. Mirrors the
 * original SurrealQL predicate `in.seq >= $parent.in.seq AND in.seq <=
 * $parent.in.seq + 3` (issue #31). Overlapping corrections dedupe via the
 * Set so exactly one UPDATE is issued per turn.
 */
export const correctedInvokedTurnKeys = (edges: readonly CorrectionEdge[]): string[] => {
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
    return [...turnsToMark];
};

export const buildWasCorrectedStatements = (turnKeys: readonly string[]): string[] =>
    turnKeys.map(
        (turnKey) =>
            `UPDATE invoked SET was_corrected = true WHERE in = turn:\`${turnKey}\` RETURN NONE;`,
    );

export const buildProposedStatements = (edges: readonly ProposedEdge[]): string[] =>
    edges.map((e) => {
        const edgeId = proposedEdgeId(e.fromTurnKey, e.skillKey);
        return `RELATE turn:\`${e.fromTurnKey}\` -> proposed:\`${edgeId}\` -> skill:\`${e.skillKey}\` SET ts = d"${e.ts}", context_excerpt = ${surrealString(e.contextExcerpt)};`;
    });

export const buildSkillPairStatements = (
    pairs: ReadonlyArray<{ readonly edgeId: string; readonly pair: SkillPairAccum }>,
): string[] =>
    pairs.map(
        ({ edgeId, pair: p }) =>
            `RELATE skill:\`${p.fromKey}\` -> skill_paired:\`${edgeId}\` -> skill:\`${p.toKey}\` SET count = ${p.count}, last_seen = d"${p.lastSeen}";`,
    );

export const buildRecoveredStatements = (edges: readonly RecoveryEdge[]): string[] =>
    edges.map((e) => {
        const edgeId = recoveredByEdgeId(e.fromTurnKey, e.skillKey);
        const excerpt = e.errorExcerpt == null ? "NONE" : surrealString(e.errorExcerpt);
        return `RELATE turn:\`${e.fromTurnKey}\` -> recovered_by:\`${edgeId}\` -> skill:\`${e.skillKey}\` SET ts = d"${e.ts}", error_excerpt = ${excerpt};`;
    });

export const buildFrictionEventStatements = (
    events: readonly DerivedFrictionEvent[],
): string[] =>
    events.map(
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

export const buildDiagnosticEventStatements = (
    events: readonly DerivedDiagnosticEvent[],
): string[] =>
    events.map(
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
