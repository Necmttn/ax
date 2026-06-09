import type { InspectTurnDto } from "@ax/lib/shared/dashboard-types";

/** Stable key for one tool call: `${callTurnSeq}:${callIndex}`. */
export function callKey(callTurnSeq: number, callIndex: number): string {
    return `${callTurnSeq}:${callIndex}`;
}

export interface ToolPairing {
    /** call key (`${callTurnSeq}:${callIndex}`) → the paired result turn's
     *  `raw_text` (still wrapped/ANSI - the renderer strips it). */
    readonly resultByCall: Map<string, string>;
    /** call key → the injected SKILL.md content for a `Skill` tool call: the
     *  following `skill_context` turn's `raw_text`. Folded into the card as its
     *  main output (the short "Launching skill: …" tool_result stays the
     *  card's launch sub-line via `resultByCall`). */
    readonly skillContentByCall: Map<string, string>;
    /** `seq`s of result/skill_context turns that were merged into a call's
     *  card, so the caller can skip rendering them standalone. */
    readonly consumedResultSeqs: Set<number>;
}

/**
 * Pair each tool_use turn's calls with the immediately-following tool_result
 * turns. For a turn carrying K calls, the next K *consecutive* `tool_result`
 * turns (in order) are its results - call index i → the i-th following result.
 *
 * Consecutiveness matters: as soon as a non-result turn (or end of list) is
 * hit, pairing for that call turn stops. This degrades gracefully when
 * something (e.g. a hook fire materialised as a turn) splits a call from its
 * result - the unmatched result stays an orphan rather than mis-merging.
 *
 * A standalone tool_result turn with no preceding matching call is left
 * unconsumed (it keeps rendering via <ToolResultView>).
 *
 * Skill folding: a `Skill` tool call's injected SKILL.md lands as a separate
 * `skill_context` turn directly after the call's "Launching skill: …"
 * tool_result. The second pass folds that content into the Skill card too, so
 * a trigger→content pair renders as one card - just like call→result. The
 * skill_context turn is only consumed when it is *adjacent* (skipping the
 * launch-line tool_result(s)) to the Skill call; if any other turn intervenes
 * the content stays a standalone turn (never drop unattributable content).
 */
export function pairToolResults(
    turns: ReadonlyArray<InspectTurnDto>,
): ToolPairing {
    const resultByCall = new Map<string, string>();
    const skillContentByCall = new Map<string, string>();
    const consumedResultSeqs = new Set<number>();

    for (let i = 0; i < turns.length; i++) {
        const turn = turns[i];
        const calls = turn.tool_calls;
        if (!calls || calls.length === 0) continue;

        // Walk the consecutive run of tool_result turns that immediately
        // follows this call turn, mapping each to the next pending call.
        let cursor = i + 1;
        for (let callIndex = 0; callIndex < calls.length; callIndex++) {
            const next = turns[cursor];
            if (!next || next.semantic_role !== "tool_result") break;
            resultByCall.set(callKey(turn.seq, callIndex), next.raw_text ?? "");
            consumedResultSeqs.add(next.seq);
            cursor++;
        }
    }

    // Second pass: fold each `Skill` call's injected `skill_context` turn into
    // its card. A skill_context turn is consumed at most once, and only when it
    // is the first content turn after the Skill call (skipping launch-line
    // tool_results). Anything else between them => leave the content standalone.
    const consumedSkillSeqs = new Set<number>();
    for (let i = 0; i < turns.length; i++) {
        const calls = turns[i].tool_calls;
        if (!calls || calls.length === 0) continue;
        for (let callIndex = 0; callIndex < calls.length; callIndex++) {
            if (calls[callIndex].name !== "Skill") continue;
            // Skip the launch-line tool_result(s) that belong to this turn,
            // then require the very next turn to be the skill_context content.
            let j = i + 1;
            while (j < turns.length && turns[j].semantic_role === "tool_result") j++;
            const candidate = turns[j];
            if (!candidate || candidate.semantic_role !== "skill_context") continue;
            if (consumedSkillSeqs.has(candidate.seq)) continue;
            skillContentByCall.set(callKey(turns[i].seq, callIndex), candidate.raw_text ?? "");
            consumedResultSeqs.add(candidate.seq);
            consumedSkillSeqs.add(candidate.seq);
        }
    }

    return { resultByCall, skillContentByCall, consumedResultSeqs };
}
