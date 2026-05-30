/**
 * Manual recommendation engine. Pulls `open` proposals from the DB and
 * ranks them by `confidence_weight × recency_weight × log(frequency+1)`.
 * Returns a flat list the CLI/dashboard can render however it likes.
 */

import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import { PROPOSAL_STATUS_OPEN } from "./lifecycle.ts";

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
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return 0.1;  // floor - same as the maximally-stale case
    const days = (Date.now() - t) / 86_400_000;
    return Math.max(0.1, 1 / Math.log(2 + Math.max(0, days)));
};

const score = (row: { confidence: string; frequency: number; updated_at: string }): number => {
    const c = CONFIDENCE_WEIGHT[row.confidence] ?? 1;
    return c * recency(row.updated_at) * (1 + Math.log1p(Math.max(0, row.frequency)));
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
            FROM proposal WHERE status = '${PROPOSAL_STATUS_OPEN}';`);
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

const guidanceBlock = (item: RecommendItem): string =>
    `${item.score.toFixed(2)}  ${item.shortId}  [${item.confidence}, ${item.frequency}/wk]  ${item.title}
    evidence: ${item.hypothesis}
    suggested:
        <!--ax:${item.shortId}-->
        ${item.title}
        <!--/ax:${item.shortId}-->
    apply: axctl improve accept ${item.shortId}`;

const skillBlock = (item: RecommendItem): string =>
    `${item.score.toFixed(2)}  ${item.shortId}  [${item.confidence}, ${item.frequency}/wk]  ${item.title}
    evidence: ${item.hypothesis}
    suggested frontmatter:
        ---
        name: ${item.title}
        ax_id: ${item.shortId}
        ---
    apply: axctl improve accept ${item.shortId}`;

export const formatRecommendations = (items: ReadonlyArray<RecommendItem>): string => {
    if (items.length === 0) return "(no recommendations - run `axctl ingest --since=1` first?)";
    return items
        .map((i) => (i.form === "skill" ? skillBlock(i) : guidanceBlock(i)))
        .join("\n\n");
};

const clipboardCmd = (): string[] | null => {
    switch (process.platform) {
        case "darwin": return ["pbcopy"];
        case "linux": return ["xclip", "-selection", "clipboard"];
        default: return null;
    }
};

export const copyToClipboard = (text: string): boolean => {
    const cmd = clipboardCmd();
    if (!cmd) return false;
    try {
        const proc = Bun.spawnSync(cmd, { stdin: new TextEncoder().encode(text) });
        return proc.exitCode === 0;
    } catch {
        return false;
    }
};

export const selectByIndices = (
    items: ReadonlyArray<RecommendItem>,
    indices: ReadonlyArray<number>,
): RecommendItem[] => {
    const set = new Set(indices);
    return items.filter((_, i) => set.has(i));
};

export const parseIndexInput = (raw: string, max: number): number[] => {
    const tokens = raw.split(/[\s,]+/).filter(Boolean);
    const out = new Set<number>();
    for (const tok of tokens) {
        const m = tok.match(/^(\d+)(?:-(\d+))?$/);
        if (!m) continue;
        const lo = parseInt(m[1]!, 10) - 1;
        const hi = m[2] ? parseInt(m[2], 10) - 1 : lo;
        for (let i = lo; i <= hi && i < max; i += 1) {
            if (i >= 0) out.add(i);
        }
    }
    return [...out].sort((a, b) => a - b);
};
