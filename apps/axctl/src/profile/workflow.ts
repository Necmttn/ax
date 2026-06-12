/**
 * Workflow arc mining: discovers frequent skill n-gram sequences
 * (bigrams + trigrams) across sessions. Pure - no Effect, no IO.
 * Input comes from fetchWindowedInvocations + skill scopes.
 */
import { isToolScope, publicSkillName } from "./rig.ts";

export interface InvocationEvent {
    readonly session: string;
    readonly skill: string;
    readonly ts: string;
}

export interface WorkflowArc {
    readonly steps: string[];
    readonly count: number;
}

/**
 * Map skill name through public-name pipeline:
 * - exclude tool-scope pseudo-skills
 * - strip project prefixes via scopes map
 * Returns null if skill should be excluded.
 */
function mapSkillName(skill: string, scopes: ReadonlyMap<string, string>): string | null {
    const scope = scopes.get(skill) ?? "user";
    if (isToolScope(scope)) return null;
    return publicSkillName(skill, scope);
}

/**
 * Mine bigram + trigram arcs from windowed invocation events.
 * Returns top 5 arcs, trigrams ranked above bigrams at equal count;
 * bigrams fully contained in a kept trigram are dropped.
 * count >= 3 threshold applied. Sorted count desc, lexicographic tiebreak.
 */
export function deriveWorkflowArcs(
    events: ReadonlyArray<InvocationEvent>,
    scopes: ReadonlyMap<string, string>,
): WorkflowArc[] {
    // Group by session, sort by ts
    const bySession = new Map<string, Array<{ skill: string; ts: string }>>();
    for (const ev of events) {
        let arr = bySession.get(ev.session);
        if (arr === undefined) { arr = []; bySession.set(ev.session, arr); }
        arr.push({ skill: ev.skill, ts: ev.ts });
    }

    // Per session: sort by ts, map names, exclude tools, collapse consecutive dupes
    const sequences: string[][] = [];
    for (const arr of bySession.values()) {
        arr.sort((a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);
        const mapped: string[] = [];
        for (const { skill } of arr) {
            const name = mapSkillName(skill, scopes);
            if (name === null) continue;
            // Collapse consecutive duplicates
            if (mapped[mapped.length - 1] !== name) mapped.push(name);
        }
        if (mapped.length >= 2) sequences.push(mapped);
    }

    // Count all bigrams and trigrams
    const bigrams = new Map<string, number>();
    const trigrams = new Map<string, number>();

    const key = (steps: string[]): string => steps.join("\0");
    const unkey = (k: string): string[] => k.split("\0");

    for (const seq of sequences) {
        for (let i = 0; i < seq.length - 1; i++) {
            const bk = key([seq[i]!, seq[i + 1]!]);
            bigrams.set(bk, (bigrams.get(bk) ?? 0) + 1);
            if (i + 2 < seq.length) {
                const tk = key([seq[i]!, seq[i + 1]!, seq[i + 2]!]);
                trigrams.set(tk, (trigrams.get(tk) ?? 0) + 1);
            }
        }
    }

    // Filter count >= 3
    const keptTrigrams: WorkflowArc[] = [];
    for (const [k, count] of trigrams) {
        if (count >= 3) keptTrigrams.push({ steps: unkey(k), count });
    }

    // Build set of bigram keys absorbed by kept trigrams
    const absorbed = new Set<string>();
    for (const arc of keptTrigrams) {
        absorbed.add(key([arc.steps[0]!, arc.steps[1]!]));
        absorbed.add(key([arc.steps[1]!, arc.steps[2]!]));
    }

    const keptBigrams: WorkflowArc[] = [];
    for (const [k, count] of bigrams) {
        if (count >= 3 && !absorbed.has(k)) {
            keptBigrams.push({ steps: unkey(k), count });
        }
    }

    // Combine: trigrams first (rank above bigrams at equal count), then bigrams
    // Sort within each group by count desc, then lexicographic
    const sort = (arcs: WorkflowArc[]): WorkflowArc[] =>
        arcs.sort((a, b) => {
            if (b.count !== a.count) return b.count - a.count;
            return a.steps.join(",") < b.steps.join(",") ? -1 : 1;
        });

    const sorted = [...sort(keptTrigrams), ...sort(keptBigrams)];

    // Enforce top 5 (trigrams already rank above bigrams by position)
    return sorted.slice(0, 5);
}
