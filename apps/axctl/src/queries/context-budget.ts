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
import { homedir } from "node:os";
import { Effect } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { safeJsonParse } from "@ax/lib/shared/safe-json";
import { surrealValue } from "@ax/lib/shared/surql";
import { guidanceConfigAuthorityHashesForScan } from "../ingest/claude-config.ts";
import { normalizeLastUsed, UNUSED_RECENT_SQL, UNUSED_SUMMARY_SQL } from "./unused-skills.ts";
import { fetchContentTypeBreakdown, type ContentTypeBreakdown } from "./content-types.ts";

const WINDOW_DAYS = 30;
const CHARS_PER_TOKEN = 4;
const toTokens = (chars: number) => Math.round(chars / CHARS_PER_TOKEN);

// Measured startup sources come from disk/DB metadata. These constants cover
// context that the harness injects but does not expose as text; the API marks
// their rows `estimated` so the studio does not present them as exact counts.
export const HARNESS_BASE_PROMPT_TOKENS = 4_200;
export const MCP_TOOL_DEFINITION_TOKENS_PER_SERVER = 650;

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

export type StartupBudgetCategory = "skills" | "claude_md" | "harness_base" | "mcp_tools";

export interface StartupBudgetSourceRow {
    readonly source: string;
    readonly category: StartupBudgetCategory;
    readonly scope: string | null;
    readonly entries: number;
    readonly chars: number;
    readonly tokens: number;
    readonly estimated: boolean;
    readonly note: string;
}

export interface GuidanceConfigBudgetRow {
    readonly kind: string;
    readonly scope: string;
    readonly safe_path: string;
    readonly authority_hash: string;
    readonly bytes: number;
    readonly token_estimate: number;
    readonly mcp_server_names_json: string | null;
}

export interface ContextBudgetResult {
    /** Distinct skills (deduped by content_hash), heaviest body first. */
    readonly skills: ReadonlyArray<SkillBudgetRow>;
    /** Per-source rollup, heaviest index first. */
    readonly sources: ReadonlyArray<SourceBudgetRow>;
    /** Full turn-zero startup footprint slices; skills are one row here. */
    readonly startupSources: ReadonlyArray<StartupBudgetSourceRow>;
    /** content-type distribution of tool outputs (token-weighted). */
    readonly contentTypes: ContentTypeBreakdown;
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
        /** Full turn-zero startup estimate across skills + config + harness/MCP estimates. */
        readonly startup_chars: number;
        readonly startup_tokens: number;
        readonly measured_startup_tokens: number;
        readonly estimated_startup_tokens: number;
        /** Recency window (days) used to judge "unused". */
        readonly window_days: number;
    };
}

const BUDGET_SQL = `
SELECT id, name, scope, bytes, string::len(description ?? "") AS desc_len, content_hash, dir_path
FROM skill;
`;

const CONFIG_BUDGET_SQL = (authorityHashes: readonly string[]) => `
SELECT kind, scope, safe_path, authority_hash, bytes, token_estimate, mcp_server_names_json
FROM guidance_config_artifact
WHERE provider = "claude"
AND authority_hash IN ${surrealValue(authorityHashes)};
`;

const isClaudeMdBudgetRow = (row: GuidanceConfigBudgetRow): boolean =>
    (row.kind === "memory" || row.kind === "guidance_doc") &&
    row.safe_path.endsWith("/CLAUDE.md");

const claudeMdSource = (scope: string): string => {
    if (scope === "user") return "CLAUDE.md · global";
    if (scope === "project") return "CLAUDE.md · project";
    return `CLAUDE.md · ${scope}`;
};

const parseJsonStringArray = (raw: string | null): string[] => {
    if (raw === null) return [];
    const parsed = safeJsonParse<unknown>(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
};

export const buildStartupBudgetSources = (
    input: {
        readonly skillIndexChars: number;
        readonly skillIndexTokens: number;
        readonly skillCount: number;
        readonly guidanceRows: ReadonlyArray<GuidanceConfigBudgetRow>;
        readonly authorityHashes?: ReadonlySet<string> | undefined;
    },
): {
    readonly sources: ReadonlyArray<StartupBudgetSourceRow>;
    readonly totals: Pick<
        ContextBudgetResult["totals"],
        "startup_chars" | "startup_tokens" | "measured_startup_tokens" | "estimated_startup_tokens"
    >;
} => {
    const sources: StartupBudgetSourceRow[] = [];
    const guidanceRows = input.authorityHashes === undefined
        ? input.guidanceRows
        : input.guidanceRows.filter((row) => input.authorityHashes?.has(row.authority_hash) ?? false);
    if (input.skillIndexTokens > 0 || input.skillCount > 0) {
        sources.push({
            source: "Skills index",
            category: "skills",
            scope: "claude",
            entries: input.skillCount,
            chars: input.skillIndexChars,
            tokens: input.skillIndexTokens,
            estimated: false,
            note: "Skill names and descriptions loaded before the first turn.",
        });
    }

    const claudeMd = new Map<string, StartupBudgetSourceRow>();
    for (const row of guidanceRows.filter(isClaudeMdBudgetRow)) {
        const source = claudeMdSource(row.scope);
        const prev = claudeMd.get(source);
        const bytes = Number(row.bytes ?? 0);
        const tokens = Number(row.token_estimate ?? toTokens(bytes));
        claudeMd.set(source, {
            source,
            category: "claude_md",
            scope: row.scope,
            entries: (prev?.entries ?? 0) + 1,
            chars: (prev?.chars ?? 0) + bytes,
            tokens: (prev?.tokens ?? 0) + tokens,
            estimated: false,
            note: row.scope === "user"
                ? "Global Claude memory file loaded into Claude Code sessions."
                : "Project CLAUDE.md loaded into sessions for this checkout.",
        });
    }
    sources.push(...claudeMd.values());

    sources.push({
        source: "Harness base prompt",
        category: "harness_base",
        scope: "claude/codex",
        entries: 1,
        chars: HARNESS_BASE_PROMPT_TOKENS * CHARS_PER_TOKEN,
        tokens: HARNESS_BASE_PROMPT_TOKENS,
        estimated: true,
        note: "Best-effort constant for the built-in Claude Code/Codex base instructions.",
    });

    const mcpServers = new Set<string>();
    for (const row of guidanceRows) {
        for (const name of parseJsonStringArray(row.mcp_server_names_json)) mcpServers.add(name);
    }
    if (mcpServers.size > 0) {
        const tokens = mcpServers.size * MCP_TOOL_DEFINITION_TOKENS_PER_SERVER;
        sources.push({
            source: "MCP tool definitions",
            category: "mcp_tools",
            scope: "claude",
            entries: mcpServers.size,
            chars: tokens * CHARS_PER_TOKEN,
            tokens,
            estimated: true,
            note: "Estimated schemas injected for configured MCP servers; raw schemas are not stored.",
        });
    }

    const startup_chars = sources.reduce((n, s) => n + s.chars, 0);
    const startup_tokens = sources.reduce((n, s) => n + s.tokens, 0);
    const measured_startup_tokens = sources
        .filter((s) => !s.estimated)
        .reduce((n, s) => n + s.tokens, 0);
    const estimated_startup_tokens = sources
        .filter((s) => s.estimated)
        .reduce((n, s) => n + s.tokens, 0);

    return {
        sources,
        totals: {
            startup_chars,
            startup_tokens,
            measured_startup_tokens,
            estimated_startup_tokens,
        },
    };
};

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
        const authorityHashes = guidanceConfigAuthorityHashesForScan({
            home: process.env.HOME ?? homedir(),
            projectRoot: process.cwd(),
        });
        // budget rows + bulk usage (per skill id) over the invoked edge table,
        // computed deref-free - see unused-skills.ts for the perf rationale.
        const [rawRes, summaryRes, recentRes, configRes, contentTypes] = yield* Effect.all([
            db.query<[Array<Record<string, unknown>>]>(BUDGET_SQL),
            db.query<[Array<Record<string, unknown>>]>(UNUSED_SUMMARY_SQL),
            db.query<[Array<Record<string, unknown>>]>(UNUSED_RECENT_SQL(WINDOW_DAYS)),
            db.query<[Array<GuidanceConfigBudgetRow>]>(CONFIG_BUDGET_SQL(authorityHashes)),
            fetchContentTypeBreakdown(),
        ], { concurrency: 4 });
        const raw = rawRes?.[0] ?? [];
        const guidanceRows = configRes?.[0] ?? [];

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
        const startup = buildStartupBudgetSources({
            skillIndexChars: cc.reduce((n, s) => n + s.index_chars, 0),
            skillIndexTokens: toTokens(cc.reduce((n, s) => n + s.index_chars, 0)),
            skillCount: cc.length,
            guidanceRows,
            authorityHashes: new Set(authorityHashes),
        });

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
            ...startup.totals,
            window_days: WINDOW_DAYS,
        };

        return { skills, sources, startupSources: startup.sources, totals, contentTypes } satisfies ContextBudgetResult;
    },
);

// ---------------------------------------------------------------------------
// drift: the append-only skill_revision change log
// ---------------------------------------------------------------------------

export interface SkillDriftRow {
    readonly kind: "skill" | "claude_md";
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

const GUIDANCE_DRIFT_SQL = (limit: number) => `
SELECT source_path, scope, change, content_hash, prev_hash, bytes, prev_bytes, observed_at
FROM guidance_revision
WHERE string::ends_with(source_path, "CLAUDE.md")
AND change IS NOT NONE
ORDER BY observed_at DESC
LIMIT ${Math.max(1, Math.trunc(limit))};
`;

const isoTimestamp = (value: unknown): string =>
    value instanceof Date ? value.toISOString() : String(value ?? "");

const guidanceDriftName = (scope: string): string => {
    if (scope === "user") return "CLAUDE.md · global";
    if (scope === "project") return "CLAUDE.md · project";
    return `CLAUDE.md · ${scope}`;
};

export const buildContextDriftRows = (
    input: {
        readonly skillRows: ReadonlyArray<Record<string, unknown>>;
        readonly guidanceRows: ReadonlyArray<Record<string, unknown>>;
        readonly limit: number;
    },
): SkillDriftRow[] => {
    const skillChanges: SkillDriftRow[] = input.skillRows.map((row) => {
        const bytes = Number(row.bytes ?? 0);
        const prev_bytes = Number(row.prev_bytes ?? 0);
        const change = String(row.change ?? "changed");
        const byte_delta = change === "added" ? 0 : bytes - prev_bytes;
        return {
            kind: "skill",
            name: String(row.name ?? "(unnamed)"),
            scope: String(row.scope ?? ""),
            change,
            ts: isoTimestamp(row.ts),
            bytes,
            prev_bytes,
            byte_delta,
            token_delta: Math.round(byte_delta / CHARS_PER_TOKEN),
        };
    });
    const guidanceChanges: SkillDriftRow[] = input.guidanceRows.map((row) => {
        const bytes = Number(row.bytes ?? 0);
        const prev_bytes = Number(row.prev_bytes ?? 0);
        const change = String(row.change ?? "changed");
        const byte_delta = change === "added" ? 0 : bytes - prev_bytes;
        const scope = String(row.scope ?? "");
        return {
            kind: "claude_md",
            name: guidanceDriftName(scope),
            scope,
            change,
            ts: isoTimestamp(row.observed_at),
            bytes,
            prev_bytes,
            byte_delta,
            token_delta: Math.round(byte_delta / CHARS_PER_TOKEN),
        };
    });
    return [...skillChanges, ...guidanceChanges]
        .sort((a, b) => (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0))
        .slice(0, Math.max(1, Math.trunc(input.limit)));
};

export const fetchSkillDrift = Effect.fn("queries.fetchSkillDrift")(
    function* (opts: { readonly limit: number }) {
        const db = yield* SurrealClient;
        const [skillRows, guidanceRows] = yield* Effect.all([
            db.query<[Array<Record<string, unknown>>]>(DRIFT_SQL(opts.limit)).pipe(Effect.map((r) => r?.[0] ?? [])),
            db.query<[Array<Record<string, unknown>>]>(GUIDANCE_DRIFT_SQL(opts.limit)).pipe(Effect.map((r) => r?.[0] ?? [])),
        ], { concurrency: 2 });

        const changes = buildContextDriftRows({ skillRows, guidanceRows, limit: opts.limit });

        return { changes, total: changes.length } satisfies SkillDriftResult;
    },
);
