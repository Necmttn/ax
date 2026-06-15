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
}

export interface SourceBudgetRow {
    readonly source: string;
    readonly skills: number;
    readonly index_chars: number;
    readonly body_chars: number;
    readonly index_tokens: number;
    readonly body_tokens: number;
    readonly is_tool: boolean;
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
    };
}

const BUDGET_SQL = `
SELECT name, scope, bytes, string::len(description ?? "") AS desc_len, content_hash, dir_path
FROM skill;
`;

/** Prefer a non-namespaced / non-project scope as the canonical home of a
 *  deduped skill (user/plugin/command over the project mirror). */
function preferScope(a: string, b: string): boolean {
    const rank = (s: string) => (s.startsWith("project") ? 2 : s.includes(":") && !s.startsWith("plugin") ? 1 : 0);
    return rank(a) <= rank(b);
}

export const fetchContextBudget = Effect.fn("queries.fetchContextBudget")(
    function* () {
        const db = yield* SurrealClient;
        const raw = yield* db.query<[Array<Record<string, unknown>>]>(BUDGET_SQL)
            .pipe(Effect.map((r) => r?.[0] ?? []));

        // Dedup by content_hash, keeping the canonical scope.
        const byHash = new Map<string, SkillBudgetRow>();
        for (const row of raw) {
            const scope = String(row.scope ?? "");
            const hash = String(row.content_hash ?? `${row.name}`);
            const index_chars = Number(row.desc_len ?? 0);
            const body_chars = Number(row.bytes ?? 0);
            const candidate: SkillBudgetRow = {
                name: String(row.name ?? "(unnamed)"),
                scope,
                source: sourceOf(scope),
                index_chars,
                body_chars,
                index_tokens: toTokens(index_chars),
                body_tokens: toTokens(body_chars),
                content_hash: hash,
                dir_path: String(row.dir_path ?? ""),
                is_tool: isToolScope(scope),
            };
            const existing = byHash.get(hash);
            if (!existing || preferScope(scope, existing.scope)) byHash.set(hash, candidate);
        }

        const skills = [...byHash.values()].sort((a, b) => b.body_chars - a.body_chars);

        // Per-source rollup.
        interface MutableSource {
            source: string; skills: number; index_chars: number; body_chars: number;
            index_tokens: number; body_tokens: number; is_tool: boolean;
        }
        const srcMap = new Map<string, MutableSource>();
        for (const s of skills) {
            const cur = srcMap.get(s.source) ?? {
                source: s.source, skills: 0, index_chars: 0, body_chars: 0,
                index_tokens: 0, body_tokens: 0, is_tool: s.is_tool,
            };
            cur.skills += 1;
            cur.index_chars += s.index_chars;
            cur.body_chars += s.body_chars;
            cur.index_tokens += s.index_tokens;
            cur.body_tokens += s.body_tokens;
            srcMap.set(s.source, cur);
        }
        const sources = [...srcMap.values()].sort((a, b) => b.index_chars - a.index_chars);

        const sum = (pick: (s: SkillBudgetRow) => number, tools: boolean) =>
            skills.filter((s) => s.is_tool === tools).reduce((n, s) => n + pick(s), 0);

        const totals = {
            skills: skills.length,
            index_chars: skills.reduce((n, s) => n + s.index_chars, 0),
            body_chars: skills.reduce((n, s) => n + s.body_chars, 0),
            index_tokens: skills.reduce((n, s) => n + s.index_tokens, 0),
            body_tokens: skills.reduce((n, s) => n + s.body_tokens, 0),
            cc_index_tokens: toTokens(sum((s) => s.index_chars, false)),
            cc_body_tokens: toTokens(sum((s) => s.body_chars, false)),
        };

        return { skills, sources, totals } satisfies ContextBudgetResult;
    },
);
