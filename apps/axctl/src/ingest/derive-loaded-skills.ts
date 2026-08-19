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
import { JsonArrayColumn, TimestampColumn } from "@ax/lib/duckdb/columns";
import { cacheRow, tsParam } from "@ax/lib/duckdb/row";
import type { CacheWriteError, CacheWriteService } from "@ax/lib/duckdb/seam";
import { stableId } from "@ax/lib/stable-id";
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

export const loadedEdgeRow = (edge: LoadedEdgeSpec) => cacheRow({
    id: stableId("loaded", [edge.child, edge.skillId]),
    in_id: edge.child,
    out_id: edge.skillId,
    ts: tsParam(edge.ts),
    agent: edge.agent,
    source: "frontmatter",
});

// ---------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------

export interface DeriveLoadedStats {
    written: number;
    agents: number;
}

const SpawnRow = Schema.Struct({
    child: Schema.String,
    agent_name: Schema.NullOr(Schema.String),
    agent_type: Schema.NullOr(Schema.String),
    ts: TimestampColumn,
});
const AgentRow = Schema.Struct({ name: Schema.String, skills: JsonArrayColumn(Schema.String) });
const SkillRow = Schema.Struct({ id: Schema.String, name: Schema.String, scope: Schema.String });

export const deriveLoadedSkills = (write: CacheWriteService): Effect.Effect<
    DeriveLoadedStats,
    CacheWriteError
> =>
    Effect.gen(function* () {
        const spawnRows = yield* write.rows(SpawnRow, "SELECT out_id AS child, agent_name, agent_type, ts FROM spawned");
        const agentRows = yield* write.rows(AgentRow, "SELECT name, skills FROM agent_def WHERE skills IS NOT NULL AND deleted_at IS NULL");
        const skillRows = yield* write.rows(SkillRow, "SELECT id, name, scope FROM skill WHERE dir_path != '(synthetic)'");

        // agent name -> declared skills
        const agentSkills = new Map<string, ReadonlyArray<string>>();
        for (const a of agentRows) {
            const name = a.name;
            const skills = a.skills.filter((skill) => skill.length > 0);
            if (skills.length > 0) agentSkills.set(name, skills);
        }

        // skill name -> id; on a plugin-namespace dupe prefer the user-scope
        // (bare) row so the edge lands on the canonical skill.
        const skillIdByName = new Map<string, string>();
        const skillScopeByName = new Map<string, string>();
        for (const s of skillRows) {
            const { name, id, scope } = s;
            const prevScope = skillScopeByName.get(name);
            if (prevScope === undefined || (prevScope !== "user" && scope === "user")) {
                skillIdByName.set(name, id);
                skillScopeByName.set(name, scope);
            }
        }

        const spawns: SpawnInput[] = spawnRows.map((r) => ({
            child: r.child,
            agentName: r.agent_name,
            agentType: r.agent_type,
            ts: r.ts.toISOString(),
        }));

        const edges = buildLoadedEdges(spawns, agentSkills, skillIdByName);
        yield* write.exec("DELETE FROM loaded");
        yield* write.putMany("loaded", edges.map(loadedEdgeRow));

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
export const loadedSkillsStage: StageDef<LoadedSkillsStats, never, CacheWriteError> = {
    meta: StageMeta.make({
        key: "loaded-skills",
        deps: ["skills", "agent-def", "spawned"],
        tags: ["derive"],
        writes: [{ table: "loaded", mode: "derive" }],
    }),
    run: (_ctx: IngestContext, write) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const result = yield* deriveLoadedSkills(write);
            return LoadedSkillsStats.make({
                durationMs: Date.now() - t0,
                summary: `wrote ${result.written} loaded edges from ${result.agents} skill-scoped agents`,
                written: result.written,
                agents: result.agents,
            });
        }),
};
