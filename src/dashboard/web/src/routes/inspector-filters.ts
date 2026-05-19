import type { InspectSpanKind, InspectTurnDto } from "@shared/dashboard-types.ts";
import {
    CORRECTION_MAX_LENGTH,
    isCorrectionPhrase,
} from "@shared/correction-phrase.ts";

/** Concatenated text of every span in a turn. Used for free-text search. */
export function turnText(turn: InspectTurnDto): string {
    let out = "";
    for (const s of turn.spans) out += s.text;
    return out;
}

/** True if this is a user_input turn whose body matches a correction phrase
 *  (shares the regex set with server-side intent classification). */
export function isCorrectionTurn(turn: InspectTurnDto): boolean {
    if (turn.semantic_role !== "user_input") return false;
    const text = turnText(turn).trim();
    if (text.length === 0 || text.length >= CORRECTION_MAX_LENGTH) return false;
    return isCorrectionPhrase(text);
}

/** True if any child was spawned anchored to this turn seq. */
export function isSpawnAnchorTurn(
    turn: InspectTurnDto,
    anchorSeqs: ReadonlySet<number>,
): boolean {
    return anchorSeqs.has(turn.seq);
}

/** True if the turn's semantic_role matches the given kind. */
export function isRoleTurn(turn: InspectTurnDto, kind: InspectSpanKind): boolean {
    return turn.semantic_role === kind;
}

/** Case-insensitive substring match against any span text. Empty/whitespace
 *  queries never match (caller should guard). */
export function matchesSearch(turn: InspectTurnDto, query: string): boolean {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return false;
    for (const s of turn.spans) {
        if (s.text.toLowerCase().includes(needle)) return true;
    }
    return false;
}

/** Filter turns and return the ordered list of matching seqs. */
export function matchingSeqs(
    turns: ReadonlyArray<InspectTurnDto>,
    predicate: (t: InspectTurnDto) => boolean,
): ReadonlyArray<number> {
    const out: number[] = [];
    for (const t of turns) if (predicate(t)) out.push(t.seq);
    return out;
}

/** Find the first seq strictly greater than `currentSeq`. If `currentSeq` is
 *  null, returns the first seq. Returns null if no match. Wraps to the first
 *  match when no later match exists (so repeated clicks cycle). */
export function nextMatchAfter(
    seqs: ReadonlyArray<number>,
    currentSeq: number | null,
): number | null {
    if (seqs.length === 0) return null;
    if (currentSeq == null) return seqs[0] ?? null;
    for (const s of seqs) if (s > currentSeq) return s;
    // No later match in the loaded window - wrap to the first.
    return seqs[0] ?? null;
}

/** Collect anchor turn seqs from the spawned-children list (skipping nulls). */
export function spawnAnchorSet(
    children: ReadonlyArray<{ readonly anchor_turn_seq: number | null }>,
): ReadonlySet<number> {
    const set = new Set<number>();
    for (const c of children) {
        if (c.anchor_turn_seq != null) set.add(c.anchor_turn_seq);
    }
    return set;
}
