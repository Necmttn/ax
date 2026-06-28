/**
 * Community compile core (profiles spec §3b), effect-free + runtime-agnostic so
 * it bundles into a Cloudflare Worker as cleanly as it runs under Bun.
 *
 * Given a registered-user list and an injectable gist fetcher, fetch each
 * profile gist, validate it through the effect-free decoder, drop invalid /
 * impersonating / absurd rows (reported, never silent), and emit deterministic
 * compiled JSON:
 *   leaderboard - boards: tokens, sessions, streak, cost
 *   skillStats  - { "<source>:<name>": { users, runs } }
 *   hookStats   - { "<hook>": { users } }
 *   patternStats - { patterns: { "<category>/<name>": { users, sessions, recovered_by? } }, dropped }
 *   state       - anonymized distributions
 *
 * The fetcher is injectable so callers choose transport (raw CDN + ETag cache
 * under Bun, plain fetch in the Worker) and tests stay pure.
 */
import {
    patternKey,
    validateProfile,
    validateTastePatterns,
    type CompiledProfile,
    type CompiledTastePattern,
    type PatternDropReason,
} from "./validate.ts";

export type { CompiledProfile } from "./validate.ts";

export interface RegisteredUser {
    readonly github: string;
    readonly gist_id: string;
    readonly joined: string;
}

export type GistFetcher = (
    gistId: string,
    owner: string,
) => Promise<{ profile: unknown; etag: string | null } | null>;

export interface BoardRow {
    readonly login: string;
    readonly value: number;
}

export interface CompiledOutput {
    readonly leaderboard: {
        readonly compiled_at: string;
        readonly window_days: number;
        readonly boards: {
            readonly tokens: BoardRow[];
            readonly sessions: BoardRow[];
            readonly streak: BoardRow[];
            readonly cost: BoardRow[];
        };
    };
    readonly skillStats: Record<string, { users: number; runs: number; source: string }>;
    readonly hookStats: Record<string, { users: number }>;
    readonly patternStats: PatternStats;
    readonly state: {
        readonly year: number;
        readonly users: number;
        readonly harness_mix: Record<string, number>;
        readonly skill_adoption: Record<string, number>;
        readonly model_share: Record<string, number>;
    };
    readonly dropped: Array<{ login: string; reason: "fetch-failed" | "invalid-profile" | "absurd-values" | "github-mismatch" }>;
}

export interface PatternStats {
    readonly compiled_at: string;
    readonly patterns: Record<string, PatternStatsRow>;
    readonly dropped: PatternStatsDrop[];
}

export interface PatternStatsRow {
    readonly category: string;
    readonly name: string;
    readonly users: number;
    readonly sessions: number;
    readonly recovered_by?: Record<string, { users: number; sessions: number }>;
}

export interface PatternStatsDrop {
    readonly login: string;
    readonly reason: PatternDropReason | "unresolved-recovery";
    readonly index?: number;
    readonly key?: string;
    readonly ref?: string;
}

const MAX_TOKENS = 100e9;
const MAX_SESSIONS = 50_000;

const sortBoard = (rows: BoardRow[]): BoardRow[] =>
    [...rows].sort((a, b) => b.value - a.value || a.login.localeCompare(b.login));

/**
 * Canonical "<source>:<name>" key for skill-stats. Plugin-namespaced skills
 * keep their plugin id INSIDE the name ("superpowers:brainstorming", source
 * "superpowers" - see rig.ts publicSkillName), so a naive `${source}:${name}`
 * doubled the prefix to "superpowers:superpowers:brainstorming". Dedupe it.
 */
export function skillStatKey(source: string, name: string): string {
    return name === source || name.startsWith(`${source}:`) ? name : `${source}:${name}`;
}

/**
 * Canonical skill IDENTITY - the bare skill name with the install-source prefix
 * stripped. The same logical skill ships differently per machine: a namespaced
 * plugin ("superpowers:brainstorming", source "superpowers") for one builder, a
 * loose ~/.claude/skills/ dir ("grill-me", source "local") for another. Source
 * is an install artifact, NOT identity - so trending aggregates on this bare
 * name, and the `users >= 2` threshold (not a `local:` exclusion) is what
 * separates shared skills from one-off personal ones. Plugin-namespaced inner
 * ids are preserved ("codex:rescue" stays "codex:rescue").
 */
export function normalizeSkillName(source: string, name: string): string {
    const key = skillStatKey(source, name);
    return key.startsWith(`${source}:`) ? key.slice(source.length + 1) : key;
}

// Curated provenance for shared skills that ship as loose ~/.claude/skills/
// dirs (source "local"), so the board can CREDIT their author instead of
// showing no badge. GENERATED from known public collections (obra/superpowers,
// mattpocock/skills, this repo's skills/, Claude built-ins) by
// scripts/gen-skill-provenance.ts - regenerate, never hand-edit the .gen file.
import { SKILL_PROVENANCE } from "./skill-provenance.gen.ts";
export { SKILL_PROVENANCE } from "./skill-provenance.gen.ts";

/**
 * Best display source for a skill. A real plugin source observed on any
 * builder's install wins (deterministic: lexicographically-first non-local);
 * else the curated provenance registry credits a known author; else "local".
 */
function representativeSource(name: string, sources: ReadonlySet<string>): string {
    const real = [...sources].filter((s) => s !== "local").sort();
    if (real[0] !== undefined) return real[0];
    return SKILL_PROVENANCE[name] ?? "local";
}

const sortedRecord = <V>(entries: Array<[string, V]>): Record<string, V> =>
    Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));

interface PatternAggregate {
    readonly category: string;
    readonly name: string;
    readonly users: Map<string, number>;
    readonly recoveryRefs: Array<{ login: string; ref: string }>;
}

function ensurePatternAggregate(
    agg: Map<string, PatternAggregate>,
    key: string,
    pattern: CompiledTastePattern,
): PatternAggregate {
    const cur = agg.get(key);
    if (cur !== undefined) return cur;
    const created: PatternAggregate = {
        category: pattern.category,
        name: pattern.name,
        users: new Map(),
        recoveryRefs: [],
    };
    agg.set(key, created);
    return created;
}

function sumSessions(users: ReadonlyMap<string, number>): number {
    let total = 0;
    for (const sessions of users.values()) total += sessions;
    return total;
}

export async function compileCommunity(
    users: ReadonlyArray<RegisteredUser>,
    fetchGist: GistFetcher,
    opts: { readonly now: string },
): Promise<CompiledOutput> {
    const profiles: Array<{ login: string; p: CompiledProfile }> = [];
    const dropped: CompiledOutput["dropped"] = [];
    const patternDrops: PatternStatsDrop[] = [];
    const patternAgg = new Map<string, PatternAggregate>();

    for (const user of [...users].sort((a, b) => a.github.localeCompare(b.github))) {
        const fetched = await fetchGist(user.gist_id, user.github);
        if (fetched === null) {
            dropped.push({ login: user.github, reason: "fetch-failed" });
            continue;
        }
        let p: CompiledProfile;
        try {
            p = validateProfile(fetched.profile);
        } catch {
            dropped.push({ login: user.github, reason: "invalid-profile" });
            continue;
        }
        // Impersonation guard: the profile's github field must match the
        // registered login (case-insensitive; logins are canonical).
        if (p.github.toLowerCase() !== user.github.toLowerCase()) {
            dropped.push({ login: user.github, reason: "github-mismatch" });
            continue;
        }
        if (p.stats.tokens.total > MAX_TOKENS || p.stats.sessions > MAX_SESSIONS) {
            dropped.push({ login: user.github, reason: "absurd-values" });
            continue;
        }
        profiles.push({ login: user.github, p });

        const taste = validateTastePatterns(fetched.profile);
        for (const d of taste.dropped) {
            patternDrops.push({
                login: user.github,
                reason: d.reason,
                ...(d.index === undefined ? {} : { index: d.index }),
                ...(d.key === undefined ? {} : { key: d.key }),
            });
        }
        for (const pattern of taste.patterns) {
            const key = patternKey(pattern.category, pattern.name);
            const cur = ensurePatternAggregate(patternAgg, key, pattern);
            cur.users.set(user.github, (cur.users.get(user.github) ?? 0) + pattern.evidence.sessions);
            for (const link of pattern.links ?? []) {
                if (pattern.category === "failure-mode" && link.rel === "recovered-by") {
                    cur.recoveryRefs.push({ login: user.github, ref: link.ref.trim() });
                }
            }
        }
    }

    const board = (value: (p: CompiledProfile) => number | undefined): BoardRow[] =>
        sortBoard(
            profiles.flatMap(({ login, p }) => {
                const v = value(p);
                return v === undefined ? [] : [{ login, value: v }];
            }),
        );

    // Aggregate skills by canonical identity (bare name), NOT by source:name -
    // see normalizeSkillName. `users` counts distinct builders, deduped within
    // a profile in case one machine has the same skill under two sources.
    const skillAgg = new Map<string, { users: number; runs: number; sources: Set<string> }>();
    const hookAgg = new Map<string, { users: number }>();
    const harnessMix = new Map<string, number>();
    const modelUsers = new Map<string, number>();
    for (const { p } of profiles) {
        const seenSkills = new Set<string>();
        for (const s of p.rig.skills) {
            const id = normalizeSkillName(s.source, s.name);
            const cur = skillAgg.get(id) ?? { users: 0, runs: 0, sources: new Set<string>() };
            cur.runs += s.runs;
            cur.sources.add(s.source);
            if (!seenSkills.has(id)) {
                cur.users += 1;
                seenSkills.add(id);
            }
            skillAgg.set(id, cur);
        }
        for (const h of p.rig.hooks) {
            const cur = hookAgg.get(h) ?? { users: 0 };
            hookAgg.set(h, { users: cur.users + 1 });
        }
        for (const h of p.stats.harnesses) {
            harnessMix.set(h, (harnessMix.get(h) ?? 0) + 1);
        }
        for (const m of p.stats.models) {
            modelUsers.set(m.name, (modelUsers.get(m.name) ?? 0) + 1);
        }
    }

    const patternEntries: Array<[string, PatternStatsRow]> = [];
    for (const [key, pattern] of patternAgg.entries()) {
        const recoveredBy = new Map<string, Map<string, number>>();
        for (const link of pattern.recoveryRefs) {
            const target = patternAgg.get(link.ref);
            if (target === undefined) {
                patternDrops.push({ login: link.login, reason: "unresolved-recovery", key, ref: link.ref });
                continue;
            }
            for (const [targetLogin, sessions] of target.users.entries()) {
                if (targetLogin === link.login) continue;
                const users = recoveredBy.get(link.ref) ?? new Map<string, number>();
                users.set(targetLogin, Math.max(users.get(targetLogin) ?? 0, sessions));
                recoveredBy.set(link.ref, users);
            }
        }

        const recoveryEntries = [...recoveredBy.entries()]
            .filter(([, targetUsers]) => targetUsers.size > 0)
            .map(([targetKey, targetUsers]) => [
                targetKey,
                { users: targetUsers.size, sessions: sumSessions(targetUsers) },
            ] as [string, { users: number; sessions: number }]);

        patternEntries.push([
            key,
            {
                category: pattern.category,
                name: pattern.name,
                users: pattern.users.size,
                sessions: sumSessions(pattern.users),
                ...(recoveryEntries.length === 0 ? {} : { recovered_by: sortedRecord(recoveryEntries) }),
            },
        ]);
    }

    return {
        leaderboard: {
            compiled_at: opts.now,
            window_days: 30,
            boards: {
                tokens: board((p) => p.stats.tokens.total),
                sessions: board((p) => p.stats.sessions),
                streak: board((p) => p.stats.streak_days),
                cost: board((p) => p.stats.cost_usd),
            },
        },
        skillStats: sortedRecord(
            [...skillAgg.entries()].map(([id, v]) => [id, { users: v.users, runs: v.runs, source: representativeSource(id, v.sources) }]),
        ),
        hookStats: sortedRecord([...hookAgg.entries()]),
        patternStats: {
            compiled_at: opts.now,
            patterns: sortedRecord(patternEntries),
            dropped: patternDrops.sort((a, b) =>
                a.login.localeCompare(b.login)
                || (a.index ?? -1) - (b.index ?? -1)
                || (a.key ?? "").localeCompare(b.key ?? "")
                || (a.ref ?? "").localeCompare(b.ref ?? "")
                || a.reason.localeCompare(b.reason),
            ),
        },
        state: {
            year: Number(opts.now.slice(0, 4)),
            users: profiles.length,
            harness_mix: sortedRecord([...harnessMix.entries()]),
            skill_adoption: sortedRecord([...skillAgg.entries()].map(([k, v]) => [k, v.users])),
            model_share: sortedRecord([...modelUsers.entries()]),
        },
        dropped,
    };
}
