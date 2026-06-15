/**
 * `ax context budget` / studio Context view: what fills a fresh Claude Code /
 * Codex session before the user types anything. Every installed skill costs
 * tokens two ways:
 *   - INDEX (always loaded): the skill's name + description sit in the system
 *     prompt's skill catalog of EVERY session, whether or not it's invoked.
 *   - BODY (on demand): the full SKILL.md loads only when the skill is invoked.
 * We measure both from the `skill` table (`bytes` = body size, `description`
 * length = index size, `content_hash` = drift detection) and roll them up by
 * source. Token estimate = chars / 4 (≈ GPT/Claude BPE average).
 *
 * Dedup: the same skill is registered under multiple scopes (e.g. `user` and
 * `project:<name>`) with an identical content_hash; the harness loads it once,
 * so we dedup by content_hash for the budget totals and attribute it to a
 * canonical source.
 *
 * Tables used (read-only): skill { name, scope, bytes, description,
 *   content_hash, dir_path }.
 */
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { normalizeLastUsed, UNUSED_RECENT_SQL, UNUSED_SUMMARY_SQL } from "./unused-skills.ts";

const WINDOW_DAYS = 30;
const CHARS_PER_TOKEN = 4;
const toTokens = (chars: number) => Math.round(chars / CHARS_PER_TOKEN);

/** Other-harness tool catalogs (codex/cursor/opencode/pi) and similar - not
 *  part of a Claude Code session's context, tracked separately. */
const TOOL_SCOPE = /-tool$/;

/** Collapse a raw scope into a display source bucket. */
function sourceOf(scope: string): string {
    if (scope === "user") return "user skills";
    if (scope === "agents-shared") return "shared agents";
    if (scope === "command") return "slash commands";
    if (scope.startsWith("project-command")) return "project commands";
    if (scope.startsWith("plugin:")) return `plugin · ${scope.slice("plugin:".length)}`;
    if (scope.startsWith("project:")) return `project · ${scope.slice("project:".length)}`;
    if (TOOL_SCOPE.test(scope)) return `${scope.replace(TOOL_SCOPE, "")} tools`;
    return scope;
}
const isToolScope = (scope: string) => TOOL_SCOPE.test(scope);

/** Description longer than this (chars) is a "trim" candidate - the always-
 *  loaded index cost is mostly a bloated frontmatter description. ~500 chars
 *  ≈ 125 tokens in every session. */
const VERBOSE_CHARS = 500;

export interface SkillBudgetRow {
    readonly name: string;
    readonly scope: string;
    readonly source: string;
    readonly index_chars: number;   // description length → always-loaded
    readonly body_chars: number;    // SKILL.md bytes → on-demand
    readonly index_tokens: number;
    readonly body_tokens: number;
    readonly content_hash: string;
    readonly dir_path: string;
    readonly is_tool: boolean;
    // usage (summed across the user↔project mirror), for cost÷usage actions
    readonly uses_total: number;
    readonly uses_window: number;   // invocations inside the recency window
    readonly last_used: string | null;
    readonly dead_weight: boolean;  // costs always-loaded tokens, unused in window → reclaim
    readonly verbose: boolean;      // bloated description → trim
}

export interface SourceBudgetRow {
    readonly source: string;
    readonly skills: number;
    readonly index_chars: number;
    readonly body_chars: number;
    readonly index_tokens: number;
    readonly body_tokens: number;
    readonly is_tool: boolean;
    readonly uses_window: number;
    readonly dead_skills: number;
    readonly reclaimable_index_tokens: number;  // always-loaded tokens from this source's dead weight
}

export interface ContextBudgetResult {
    /** Distinct skills (deduped by content_hash), heaviest body first. */
    readonly skills: ReadonlyArray<SkillBudgetRow>;
    /** Per-source rollup, heaviest index first. */
    readonly sources: ReadonlyArray<SourceBudgetRow>;
    readonly totals: {
        readonly skills: number;
        readonly index_chars: number;
        readonly body_chars: number;
        readonly index_tokens: number;
        readonly body_tokens: number;
        /** Claude-skill subset only (excludes other-harness tool catalogs). */
        readonly cc_index_tokens: number;
        readonly cc_body_tokens: number;
        /** Always-loaded tokens recoverable by disabling unused (dead-weight) skills. */
        readonly reclaimable_index_tokens: number;
        readonly reclaimable_skills: number;
        readonly verbose_skills: number;
        /** Recency window (days) used to judge "unused". */
        readonly window_days: number;
    };
}

const BUDGET_SQL = `
SELECT id, name, scope, bytes, string::len(description ?? "") AS desc_len, content_hash, dir_path
FROM skill;
`;

/** Prefer a non-namespaced / non-project scope as the canonical home of a
 *  deduped skill (user/plugin/command over the project mirror). */
function preferScope(a: string, b: string): boolean {
    const rank = (s: string) => (s.startsWith("project") ? 2 : s.includes(":") && !s.startsWith("plugin") ? 1 : 0);
    return rank(a) <= rank(b);
}
const idStr = (v: unknown) => String(v ?? "");

export const fetchContextBudget = Effect.fn("queries.fetchContextBudget")(
    function* () {
        const db = yield* SurrealClient;
        // budget rows + bulk usage (per skill id) over the invoked edge table,
        // computed deref-free - see unused-skills.ts for the perf rationale.
        const [rawRes, summaryRes, recentRes] = yield* Effect.all([
            db.query<[Array<Record<string, unknown>>]>(BUDGET_SQL),
            db.query<[Array<Record<string, unknown>>]>(UNUSED_SUMMARY_SQL),
            db.query<[Array<Record<string, unknown>>]>(UNUSED_RECENT_SQL(WINDOW_DAYS)),
        ], { concurrency: 3 });
        const raw = rawRes?.[0] ?? [];

        const usageById = new Map<string, { uses: number; last: string | null }>();
        for (const r of summaryRes?.[0] ?? []) {
            usageById.set(idStr(r.skill_id), { uses: Number(r.total_inv ?? 0), last: normalizeLastUsed(r.last_used) });
        }
        const recentById = new Map<string, number>();
        for (const r of recentRes?.[0] ?? []) recentById.set(idStr(r.skill_id), Number(r.recent ?? 0));

        // Group by content_hash: sum usage across the mirror ids, keep canonical.
        interface Group { canonical: Record<string, unknown>; canonicalScope: string; uses: number; window: number; last: string | null; }
        const groups = new Map<string, Group>();
        for (const row of raw) {
            const hash = String(row.content_hash ?? `${row.name}`);
            const scope = String(row.scope ?? "");
            const id = idStr(row.id);
            const u = usageById.get(id);
            const win = recentById.get(id) ?? 0;
            const g = groups.get(hash);
            if (!g) {
                groups.set(hash, { canonical: row, canonicalScope: scope, uses: u?.uses ?? 0, window: win, last: u?.last ?? null });
            } else {
                g.uses += u?.uses ?? 0;
                g.window += win;
                if (u?.last && (!g.last || u.last > g.last)) g.last = u.last;
                if (preferScope(scope, g.canonicalScope)) { g.canonical = row; g.canonicalScope = scope; }
            }
        }

        const skills: SkillBudgetRow[] = [...groups.values()].map((g) => {
            const row = g.canonical;
            const scope = String(row.scope ?? "");
            const index_chars = Number(row.desc_len ?? 0);
            const body_chars = Number(row.bytes ?? 0);
            const is_tool = isToolScope(scope);
            return {
                name: String(row.name ?? "(unnamed)"),
                scope,
                source: sourceOf(scope),
                index_chars,
                body_chars,
                index_tokens: toTokens(index_chars),
                body_tokens: toTokens(body_chars),
                content_hash: String(row.content_hash ?? ""),
                dir_path: String(row.dir_path ?? ""),
                is_tool,
                uses_total: g.uses,
                uses_window: g.window,
                last_used: g.last,
                dead_weight: !is_tool && g.window === 0 && index_chars > 0,
                verbose: !is_tool && index_chars > VERBOSE_CHARS,
            };
        }).sort((a, b) => b.body_chars - a.body_chars);

        // Per-source rollup (+ usage / reclaim).
        interface MutableSource {
            source: string; skills: number; index_chars: number; body_chars: number;
            index_tokens: number; body_tokens: number; is_tool: boolean;
            uses_window: number; dead_skills: number; reclaimable_index_tokens: number;
        }
        const srcMap = new Map<string, MutableSource>();
        for (const s of skills) {
            const cur = srcMap.get(s.source) ?? {
                source: s.source, skills: 0, index_chars: 0, body_chars: 0,
                index_tokens: 0, body_tokens: 0, is_tool: s.is_tool,
                uses_window: 0, dead_skills: 0, reclaimable_index_tokens: 0,
            };
            cur.skills += 1;
            cur.index_chars += s.index_chars;
            cur.body_chars += s.body_chars;
            cur.index_tokens += s.index_tokens;
            cur.body_tokens += s.body_tokens;
            cur.uses_window += s.uses_window;
            if (s.dead_weight) { cur.dead_skills += 1; cur.reclaimable_index_tokens += s.index_tokens; }
            srcMap.set(s.source, cur);
        }
        const sources = [...srcMap.values()].sort((a, b) => b.index_chars - a.index_chars);

        const cc = skills.filter((s) => !s.is_tool);
        const totals = {
            skills: skills.length,
            index_chars: skills.reduce((n, s) => n + s.index_chars, 0),
            body_chars: skills.reduce((n, s) => n + s.body_chars, 0),
            index_tokens: skills.reduce((n, s) => n + s.index_tokens, 0),
            body_tokens: skills.reduce((n, s) => n + s.body_tokens, 0),
            cc_index_tokens: toTokens(cc.reduce((n, s) => n + s.index_chars, 0)),
            cc_body_tokens: toTokens(cc.reduce((n, s) => n + s.body_chars, 0)),
            reclaimable_index_tokens: cc.filter((s) => s.dead_weight).reduce((n, s) => n + s.index_tokens, 0),
            reclaimable_skills: cc.filter((s) => s.dead_weight).length,
            verbose_skills: cc.filter((s) => s.verbose).length,
            window_days: WINDOW_DAYS,
        };

        return { skills, sources, totals } satisfies ContextBudgetResult;
    },
);

// ---------------------------------------------------------------------------
// drift: the append-only skill_revision change log
// ---------------------------------------------------------------------------

export interface SkillDriftRow {
    readonly name: string;
    readonly scope: string;
    readonly change: string;        // 'added' | 'changed'
    readonly ts: string;            // ISO
    readonly bytes: number;
    readonly prev_bytes: number;
    readonly byte_delta: number;    // bytes - prev_bytes (0 for 'added')
    readonly token_delta: number;   // byte_delta / 4
}

export interface SkillDriftResult {
    readonly changes: ReadonlyArray<SkillDriftRow>;
    readonly total: number;
}

const DRIFT_SQL = (limit: number) => `
SELECT name, scope, change, content_hash, prev_hash, bytes, prev_bytes, ts
FROM skill_revision
ORDER BY ts DESC
LIMIT ${Math.max(1, Math.trunc(limit))};
`;

export const fetchSkillDrift = Effect.fn("queries.fetchSkillDrift")(
    function* (opts: { readonly limit: number }) {
        const db = yield* SurrealClient;
        const rows = yield* db.query<[Array<Record<string, unknown>>]>(DRIFT_SQL(opts.limit))
            .pipe(Effect.map((r) => r?.[0] ?? []));

        const changes: SkillDriftRow[] = rows.map((row) => {
            const bytes = Number(row.bytes ?? 0);
            const prev_bytes = Number(row.prev_bytes ?? 0);
            const byte_delta = row.change === "added" ? 0 : bytes - prev_bytes;
            const ts = row.ts instanceof Date ? row.ts.toISOString() : String(row.ts ?? "");
            return {
                name: String(row.name ?? "(unnamed)"),
                scope: String(row.scope ?? ""),
                change: String(row.change ?? "changed"),
                ts,
                bytes,
                prev_bytes,
                byte_delta,
                token_delta: Math.round(byte_delta / CHARS_PER_TOKEN),
            };
        });

        return { changes, total: changes.length } satisfies SkillDriftResult;
    },
);
