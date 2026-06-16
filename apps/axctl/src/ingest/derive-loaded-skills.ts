/**
 * @stage loaded-skills
 * @rationale The `invoked` edge captures only explicit Skill-tool calls (and,
 *   via `commands.ts`, slash-commands). Skills that load because a subagent's
 *   `skills:` frontmatter pulls them in NEVER produce a Skill-tool call, so they
 *   leave no `invoked` edge - they are invisible to every usage view even though
 *   they were activated. This stage draws that missing activation signal as a
 *   SEPARATE `loaded` edge (session -> skill) so it can light up edit→outcome
 *   analysis (see docs/.../churn-as-gate-grade-experiment.md) WITHOUT polluting
 *   `invoked`-based usage analytics (skills weighted, taste, churn).
 * @inputs `spawned` edges (which subagent spawned, when), `agent_def.skills`
 *   (the agent's declared skill list), `skill` rows (name -> id resolution)
 * @outputs `loaded` edges: child session -> skill, SET ts, agent, source
 * @order after skills, agent-def, spawned
 *
 * Fully derived + idempotent: the stage wipes `loaded` and rebuilds it from
 * current state each run (the table is small and 100% derivable), so there is no
 * incremental-merge subtlety.
 */
import { Effect, Schema } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import {
    executeStatementsWith,
    recordKeyPart,
    recordRef,
    safeKeyPart,
    surrealDate,
    surrealString,
} from "@ax/lib/shared/surreal";
import { BaseStageStats, IngestContext, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";

// ---------------------------------------------------------------------------
// Pure derivation
// ---------------------------------------------------------------------------

export interface SpawnInput {
    /** full child-session record id, e.g. "session:abc" */
    readonly child: string;
    readonly agentName: string | null;
    readonly agentType: string | null;
    /** ISO timestamp of the spawn */
    readonly ts: string;
}

export interface LoadedEdgeSpec {
    readonly child: string;
    readonly skillId: string;
    readonly agent: string;
    readonly ts: string;
}

/**
 * Build the `loaded` activation edges. For each spawn, resolve the agent (by
 * `agentName`, falling back to `agentType`) to its declared skills, then to the
 * skill record ids. One edge per (child session, skill); when the same pair
 * spawns more than once the EARLIEST ts wins (first activation).
 */
export const buildLoadedEdges = (
    spawns: ReadonlyArray<SpawnInput>,
    agentSkills: ReadonlyMap<string, ReadonlyArray<string>>,
    skillIdByName: ReadonlyMap<string, string>,
): LoadedEdgeSpec[] => {
    const byKey = new Map<string, LoadedEdgeSpec>();
    for (const sp of spawns) {
        if (!sp.child) continue;
        const agent =
            sp.agentName && agentSkills.has(sp.agentName)
                ? sp.agentName
                : sp.agentType && agentSkills.has(sp.agentType)
                  ? sp.agentType
                  : null;
        if (!agent) continue;
        for (const name of agentSkills.get(agent) ?? []) {
            const skillId = skillIdByName.get(name);
            if (!skillId) continue;                       // skill not in catalog
            const key = `${sp.child}|${skillId}`;
            const existing = byKey.get(key);
            if (!existing || sp.ts < existing.ts) {
                byKey.set(key, { child: sp.child, skillId, agent, ts: sp.ts });
            }
        }
    }
    return [...byKey.values()];
};

/** Render one `loaded` edge to a RELATE statement (deterministic edge id). */
export const renderLoadedEdge = (e: LoadedEdgeSpec): string | null => {
    const childKey = recordKeyPart(e.child, "session");
    const skillKey = recordKeyPart(e.skillId, "skill");
    if (!childKey || !skillKey) return null;
    const edgeKey = safeKeyPart(`${e.child}|${e.skillId}`);
    return (
        `RELATE ${recordRef("session", childKey)}->${recordRef("loaded", edgeKey)}->` +
        `${recordRef("skill", skillKey)} SET ts = ${surrealDate(e.ts)}, ` +
        `agent = ${surrealString(e.agent)}, source = 'frontmatter';`
    );
};

// ---------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------

export interface DeriveLoadedStats {
    written: number;
    agents: number;
}

type SpawnRow = { child: unknown; agent_name: unknown; agent_type: unknown; ts: unknown };
type AgentRow = { name: unknown; skills: unknown };
type SkillRow = { id: unknown; name: unknown; scope: unknown };

export const deriveLoadedSkills = (): Effect.Effect<
    DeriveLoadedStats,
    DbError,
    SurrealClient
> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;

        const [spawnRows, agentRows, skillRows] = yield* db.query<[
            Array<SpawnRow>,
            Array<AgentRow>,
            Array<SkillRow>,
        ]>(`
            SELECT type::string(out) AS child, agent_name, agent_type, type::string(ts) AS ts FROM spawned;
            SELECT name, skills FROM agent_def WHERE skills != NONE AND deleted_at IS NONE;
            SELECT type::string(id) AS id, name, scope FROM skill WHERE dir_path != '(synthetic)';
        `);

        // agent name -> declared skills
        const agentSkills = new Map<string, ReadonlyArray<string>>();
        for (const a of agentRows ?? []) {
            const name = typeof a.name === "string" ? a.name : null;
            if (!name) continue;
            const skills = Array.isArray(a.skills)
                ? a.skills.filter((s): s is string => typeof s === "string" && s.length > 0)
                : [];
            if (skills.length > 0) agentSkills.set(name, skills);
        }

        // skill name -> id; on a plugin-namespace dupe prefer the user-scope
        // (bare) row so the edge lands on the canonical skill.
        const skillIdByName = new Map<string, string>();
        const skillScopeByName = new Map<string, string>();
        for (const s of skillRows ?? []) {
            const name = typeof s.name === "string" ? s.name : null;
            const id = typeof s.id === "string" ? s.id : null;
            if (!name || !id) continue;
            const scope = typeof s.scope === "string" ? s.scope : "";
            const prevScope = skillScopeByName.get(name);
            if (prevScope === undefined || (prevScope !== "user" && scope === "user")) {
                skillIdByName.set(name, id);
                skillScopeByName.set(name, scope);
            }
        }

        const spawns: SpawnInput[] = (spawnRows ?? []).map((r) => ({
            child: typeof r.child === "string" ? r.child : "",
            agentName: typeof r.agent_name === "string" ? r.agent_name : null,
            agentType: typeof r.agent_type === "string" ? r.agent_type : null,
            ts: typeof r.ts === "string" ? r.ts : "",
        }));

        const edges = buildLoadedEdges(spawns, agentSkills, skillIdByName);
        const stmts = ["DELETE loaded;"];
        for (const e of edges) {
            const sql = renderLoadedEdge(e);
            if (sql) stmts.push(sql);
        }
        yield* executeStatementsWith(db, stmts, { chunkSize: 250, label: "loadedEdges" });

        return { written: edges.length, agents: agentSkills.size };
    });

export const LoadedSkillsKey = Schema.Literal("loaded-skills");
export type LoadedSkillsKey = typeof LoadedSkillsKey.Type;

export class LoadedSkillsStats extends BaseStageStats.extend<LoadedSkillsStats>(
    "LoadedSkillsStats",
)({
    written: Schema.Number,
    agents: Schema.Number,
}) {}

/**
 * Loaded-skills stage - derives auto-load activation edges.
 *
 * Depends on: skills (catalog), agent-def (declared skills), spawned (who/when).
 * Consumed by: edit→outcome analysis; kept separate from `invoked` usage views.
 * Tags: derive
 */
export const loadedSkillsStage: StageDef<LoadedSkillsStats, SurrealClient> = {
    meta: StageMeta.make({
        key: "loaded-skills",
        deps: ["skills", "agent-def", "spawned"],
        tags: ["derive"],
    }),
    run: (_ctx: IngestContext) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const result = yield* deriveLoadedSkills();
            return LoadedSkillsStats.make({
                durationMs: Date.now() - t0,
                summary: `wrote ${result.written} loaded edges from ${result.agents} skill-scoped agents`,
                written: result.written,
                agents: result.agents,
            });
        }),
};
