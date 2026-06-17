/**
 * Directive detection - the v1 MVP of directive mining (spec
 * docs/superpowers/specs/2026-06-17-directive-mining-design.md §0.1).
 *
 * `deriveCorrections` (signals/core.ts) catches *reactive* push-back ("no",
 * "that's wrong"). This catches the complementary *proactive* signal: standing
 * "how to work" instructions the user states up front ("from now on X", "always
 * run Y", "remember to Z") - the highest-signal source for durable guidance,
 * and the gap corrections leave.
 *
 * Pure + DB-free. The `proposals` stage runs it over user turns and mints
 * `guidance`-form proposals through the EXISTING proposal pipeline (no new
 * tables, no n-gram miner - those are deferred v2). Recurrence/landing/accept/
 * verdict all come for free from `deriveProposals` + `improve`.
 */
import { isHarnessInjected } from "./signals/core.ts";

// Standing-rule lead-ins: each is a strong proactive-directive signal on its
// own (unlike bare "always"/"never", which need an imperative verb - see below
// - to avoid firing on ordinary prose like "I always thought...").
const DIRECTIVE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
    [/\bfrom now on\b/, "from now on"],
    [/\bgoing forward\b/, "going forward"],
    [/\bfrom here on\b/, "from here on"],
    [/\bin (?:the )?future\b/, "in the future"],
    [/\bfor future reference\b/, "for future reference"],
    [/\bas a rule\b/, "as a rule"],
    [/\bremember to\b/, "remember to"],
    [/\bremember,? that\b/, "remember that"],
    [/\bmake sure (?:you|to|that)\b/, "make sure you"],
    [/\bbe sure to\b/, "be sure to"],
    [/\bevery time\b/, "every time"],
    [/\beach time\b/, "each time"],
    [/\bwhenever you\b/, "whenever you"],
    [/\bany time you\b/, "any time you"],
    [/\byou should always\b/, "you should always"],
    [/\byou should never\b/, "you should never"],
    [/\bplease always\b/, "please always"],
    [/\bplease never\b/, "please never"],
    [/\bdon'?t ever\b/, "don't ever"],
    [/\bnever ever\b/, "never ever"],
    // Bare always/never ONLY when followed by an imperative verb - this is the
    // standing-rule frame ("always run", "never commit"), not prose.
    [/\balways (?:use|run|check|verify|prefer|include|add|make|do|keep|start|wrap|read|write|commit|test|ask|confirm|follow|avoid)\b/, "always-verb"],
    [/\bnever (?:use|run|commit|push|edit|delete|skip|forget|do|merge|hardcode|leave|assume|guess)\b/, "never-verb"],
] as const;

// Scan only the turn-INITIAL window. Genuine directives lead with their marker
// ("Always run...", "Remember to...", "From now on..."); a marker buried mid-turn
// usually belongs to a task/question/design-chat that merely mentions it - the
// remaining false-positive class the live smoke surfaced after the length filter.
const DIRECTIVE_WINDOW_CHARS = 80;
const MIN_DIRECTIVE_CHARS = 12;
// Genuine standing directives are concise ("always run the tests"). Long turns
// are task descriptions, dispatch prompts, or pasted content that happen to
// contain a marker word - the dominant false-positive class the live smoke
// surfaced. Cap length to keep precision high.
const MAX_DIRECTIVE_CHARS = 600;

/** Returns the matched directive marker label, or null. Scans only the head. */
export function matchDirective(text: string): string | null {
    const trimmed = text.trim();
    if (trimmed.length < MIN_DIRECTIVE_CHARS) return null;
    if (trimmed.length > MAX_DIRECTIVE_CHARS) return null;
    const head = text.slice(0, DIRECTIVE_WINDOW_CHARS).toLowerCase();
    for (const [re, label] of DIRECTIVE_PATTERNS) {
        if (re.test(head)) return label;
    }
    return null;
}

export interface DirectiveTurnRow {
    readonly id: string;
    readonly session: string;
    readonly text_excerpt: string | null;
    readonly ts: string | Date;
}

export interface DirectiveCandidate {
    readonly turnKey: string;
    readonly sessionId: string;
    readonly text: string;
    readonly pattern: string;
    readonly ts: string;
}

const cleanTurnKey = (id: string): string =>
    id.replace(/^turn:/, "").replace(/^`(.*)`$/, "$1");

const isoTs = (ts: string | Date): string =>
    ts instanceof Date ? ts.toISOString() : String(ts);

/**
 * Scan user turns for proactive standing-instruction directives. Unlike
 * corrections, a directive is NOT anchored to a prior assistant turn (it's
 * stated up front), so this is a straight per-turn scan. Harness-injected and
 * empty turns are skipped (same guard `deriveCorrections` uses).
 */
export function deriveDirectiveCandidates(
    turns: readonly DirectiveTurnRow[],
): DirectiveCandidate[] {
    const out: DirectiveCandidate[] = [];
    for (const t of turns) {
        const text = t.text_excerpt;
        if (!text) continue;
        if (isHarnessInjected(text)) continue;
        const pattern = matchDirective(text);
        if (!pattern) continue;
        out.push({
            turnKey: cleanTurnKey(t.id),
            sessionId: t.session,
            text,
            pattern,
            ts: isoTs(t.ts),
        });
    }
    return out;
}
