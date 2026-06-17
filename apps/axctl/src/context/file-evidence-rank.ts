import type { MentionSignals, SessionTurn, ToolEvidenceRow, TouchRow } from "./file-evidence-types.ts";

// ============================================================================
// File Evidence - pure (DB-free) signal extraction, ranking, and compaction.
//
// No SurrealClient, no Effect: every function here is a synchronous transform
// over already-fetched rows or a raw query string. This is the unit-test
// surface for the logic that actually carries bugs; the retrieval primitives
// (file-evidence.ts) and the renderers (adapters) compose these.
// ============================================================================

export const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}...`);

export function numeric(value: number | null | undefined): number {
    return Number.isFinite(value) ? Math.max(0, Number(value)) : 0;
}

export function durationMs(startedAt: string | null | undefined, endedAt: string | null | undefined): number | null {
    if (!startedAt || !endedAt) return null;
    const start = new Date(startedAt).getTime();
    const end = new Date(endedAt).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
    return end - start;
}

const STOP_WORDS = new Set(["after", "from", "with", "that", "this", "when", "then", "into", "bug"]);

export function queryTokens(q: string): readonly string[] {
    return Array.from(
        new Set(
            q.toLowerCase()
                .split(/[^a-z0-9_]+/)
                .filter((token) => token.length >= 4 && !STOP_WORDS.has(token)),
        ),
    ).slice(0, 24);
}

function extractPathHints(q: string): string[] {
    const paths = q.match(/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|surql|sql|md|json)/g) ?? [];
    return Array.from(new Set(paths));
}

export function extractFileContextSignals(q: string, files: readonly string[]): MentionSignals {
    const paths = Array.from(new Set([...extractPathHints(q), ...files].map((path) => path.trim()).filter(Boolean)));
    const quoted = Array.from(q.matchAll(/"([^"]{4,160})"|'([^']{4,160})'|`([^`]{4,160})`/g))
        .map((m) => m[1] ?? m[2] ?? m[3])
        .filter(Boolean);
    const errorish = Array.from(
        q.matchAll(/\b(?:Error|Exception|TypeError|ReferenceError|SqlError|DbError):?\s+([^.;\n]{6,160})/gi),
    ).map((m) => m[0]);
    const symbols = Array.from(
        new Set(
            [
                ...(q.match(/\b[A-Z][A-Za-z0-9]+(?:[A-Z][A-Za-z0-9]+)+\b/g) ?? []),
                ...(q.match(/\b[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*\b/g) ?? []),
                ...(q.match(/\b[a-z][a-z0-9]+(?:_[a-z0-9]+)+\b/g) ?? []),
                ...(q.match(/\b[a-zA-Z_$][a-zA-Z0-9_$]{3,}\(/g) ?? []).map((s) => s.slice(0, -1)),
            ].filter((s) => !["Error", "Bug"].includes(s)),
        ),
    ).slice(0, 16);
    const errors = Array.from(new Set([...quoted, ...errorish])).slice(0, 8);
    return { paths, symbols, errors };
}

export function rankToolEvidence(row: ToolEvidenceRow): number {
    let score = row.kind === "searched_file" ? 12 : 10;
    if (row.command_norm === "rg" || row.command_norm === "grep") score += 3;
    if (row.tool_name === "Read") score += 2;
    if (row.turn?.intent_kind === "correction" || row.turn?.intent_kind === "preference") score += 2;
    return score;
}

export function rankSessionTurn(turn: SessionTurn, tokens: readonly string[]): number {
    const text = (turn.text_excerpt ?? "").toLowerCase();
    let score = 0;
    if (turn.intent_kind === "correction" || turn.intent_kind === "preference") score += 4;
    if (turn.intent_kind === "organic_task") score += 2;
    for (const token of tokens) {
        if (text.includes(token)) score += 2;
    }
    if (text.length > 20) score += 1;
    return score;
}

export function rankSessionTurns(turns: readonly SessionTurn[], tokens: readonly string[]): readonly SessionTurn[] {
    return turns
        .filter((turn) => !!turn.text_excerpt?.trim())
        .slice()
        .sort((a, b) => rankSessionTurn(b, tokens) - rankSessionTurn(a, tokens) || (b.ts ?? "").localeCompare(a.ts ?? ""));
}

export function compactTouchesForContext(touches: readonly TouchRow[]): readonly TouchRow[] {
    const best = new Map<string, TouchRow>();
    for (const touch of touches) {
        const key = touch.commit?.sha ?? touch.commit?.message ?? touch.id;
        if (!best.has(key)) best.set(key, touch);
    }
    return Array.from(best.values());
}

export function compactToolEvidence(rows: readonly ToolEvidenceRow[]): ToolEvidenceRow[] {
    const best = new Map<string, ToolEvidenceRow>();
    for (const row of rows) {
        const key = [row.kind, row.path ?? row.path_seen ?? "?", row.tool_name ?? "", row.command_norm ?? ""].join("|");
        const existing = best.get(key);
        if (!existing || rankToolEvidence(row) > rankToolEvidence(existing)) {
            best.set(key, row);
        }
    }
    return Array.from(best.values())
        .sort((a, b) => rankToolEvidence(b) - rankToolEvidence(a) || (b.ts ?? "").localeCompare(a.ts ?? ""));
}
