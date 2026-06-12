/**
 * Derive taste patterns from accepted improve proposals (the v1 taste
 * source per spec §1: "entries derive from existing ax improve proposals /
 * classifier output where present, section omitted otherwise").
 * Earned confidence: values come from real proposal records, never invented.
 * stack-choice derivation is deferred (needs dep/import signals).
 */
import type { ProposalRow } from "./queries.ts";
import type { TastePattern } from "./schema.ts";

const CONFIDENCE_LABELS: Record<string, number> = {
    high: 0.9,
    medium: 0.7,
    low: 0.5,
};

export function parseConfidence(raw: string): number {
    const label = CONFIDENCE_LABELS[raw.trim().toLowerCase()];
    if (label !== undefined) return label;
    const n = Number.parseFloat(raw);
    if (Number.isFinite(n)) return Math.min(1, Math.max(0, n));
    return 0.5;
}

export function slugify(title: string): string {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

/** Prose-only categories (excludes stack-choice, which needs dep signals). */
type ProseCategory = "design-aesthetic" | "problem-solving-strategy" | "debugging" | "failure-mode" | "workflow";

/** form -> category; deliberately small, extend as forms appear. */
const FORM_TO_CATEGORY: Record<string, ProseCategory> = {
    guidance: "workflow",
    hook: "workflow",
    skill: "workflow",
    debugging: "debugging",
};

const dayOf = (iso: string): string => iso.slice(0, 10);

export function deriveTastePatterns(rows: ReadonlyArray<ProposalRow>): TastePattern[] {
    const byName = new Map<string, { row: ProposalRow; pattern: TastePattern }>();
    for (const row of rows) {
        if (row.hypothesis.trim() === "" || row.title.trim() === "") continue;
        const name = slugify(row.title);
        if (name === "") continue;
        const existing = byName.get(name);
        if (existing && existing.row.frequency >= row.frequency) continue;
        const reinforced = row.updated_at ?? row.created_at;
        const category: ProseCategory = FORM_TO_CATEGORY[row.form] ?? "workflow";
        byName.set(name, {
            row,
            pattern: {
                category,
                name,
                summary: row.hypothesis,
                evidence: {
                    sessions: row.frequency,
                    confidence: parseConfidence(row.confidence),
                    ...(reinforced ? { last_reinforced: dayOf(reinforced) } : {}),
                    trend: "stable",
                },
            },
        });
    }
    return [...byName.values()].map((v) => v.pattern);
}
