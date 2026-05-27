/**
 * Manual recommendation engine. Pulls `open` proposals from the DB and
 * ranks them by `confidence_weight × recency_weight × log(frequency+1)`.
 * Returns a flat list the CLI/dashboard can render however it likes.
 */

import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";

export interface RecommendInput {
    readonly limit: number;
    readonly forms?: ReadonlyArray<string>;
    readonly project?: string;
    readonly cwd?: string;
    readonly agent?: "claude" | "codex";
    readonly sinceDays?: number;
}

export interface RecommendItem {
    readonly shortId: string;
    readonly title: string;
    readonly form: string;
    readonly hypothesis: string;
    readonly confidence: string;
    readonly frequency: number;
    readonly score: number;
    readonly updatedAt: string;
}

const CONFIDENCE_WEIGHT: Record<string, number> = {
    high: 3,
    medium: 2,
    low: 1,
};

const recency = (iso: string): number => {
    const days = (Date.now() - new Date(iso).getTime()) / 86_400_000;
    return Math.max(0.1, 1 / Math.log(2 + Math.max(0, days)));
};

const score = (row: { confidence: string; frequency: number; updated_at: string }): number => {
    const c = CONFIDENCE_WEIGHT[row.confidence] ?? 1;
    return c * recency(row.updated_at) * Math.log(row.frequency + 1 + 1e-3);
};

export const recommend = (
    input: RecommendInput,
): Effect.Effect<RecommendItem[], DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const result = yield* db.query<[ReadonlyArray<{
            dedupe_sig: string; title: string; form: string; hypothesis: string;
            confidence: string; frequency: number; updated_at: string;
        }>]>(`SELECT dedupe_sig, title, form, hypothesis, confidence, frequency,
                type::string(updated_at) AS updated_at
            FROM proposal WHERE status = 'open';`);
        let rows = result?.[0] ?? [];
        if (input.forms && input.forms.length > 0) {
            const set = new Set(input.forms);
            rows = rows.filter((r) => set.has(r.form));
        }
        if (input.sinceDays != null) {
            const cutoff = Date.now() - input.sinceDays * 86_400_000;
            rows = rows.filter((r) => new Date(r.updated_at).getTime() >= cutoff);
        }
        const ranked: RecommendItem[] = rows
            .map((r) => ({
                shortId: r.dedupe_sig,
                title: r.title,
                form: r.form,
                hypothesis: r.hypothesis,
                confidence: r.confidence,
                frequency: r.frequency,
                updatedAt: r.updated_at,
                score: score(r),
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, input.limit);
        return ranked;
    });
