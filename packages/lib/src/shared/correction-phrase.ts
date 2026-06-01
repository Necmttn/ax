/**
 * Tight correction-phrase regex set. Requires either a leading negation/pause
 * marker or a high-signal correction verb. Avoids generic keywords like
 * "wait" and "actually" that fire on unrelated text.
 *
 * Shared between server-side intent classification (`src/ingest/intent-kind.ts`)
 * and the dashboard inspector's "next correction" jump button so both use the
 * same definition of a user correction.
 */
export function isCorrectionPhrase(text: string): boolean {
    if (/^(no[,\s]|stop[,\s]|wait,|hmm,|actually,)/i.test(text)) return true;
    if (/\bdon'?t (do|use|add|mock|change|touch|edit)\b/i.test(text)) return true;
    if (/\b(this|that)('?s| (is|was|are|were)) wrong\b/i.test(text)) return true;
    if (/\bi was talking about\b/i.test(text)) return true;
    if (/\b(you misunderstood|not what i (asked|wanted|meant))\b/i.test(text)) return true;
    if (/\b(go back|revert (it|that|this|the change)|undo that|never ?mind)\b/i.test(text)) return true;
    if (/\b(i said|i told you)\b/i.test(text)) return true;
    if (/\bdid you (test|check|read)\b/i.test(text)) return true;
    return false;
}

/** Max text length for a user_input turn to be considered a correction.
 *  Long bodies are almost never corrections - they're slash-command templates,
 *  FAQ pastes, or design docs that happen to contain keywords like "wait." */
export const CORRECTION_MAX_LENGTH = 500;
