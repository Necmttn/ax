import { Effect, FileSystem, Path } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import type { PlatformError } from "effect/PlatformError";
import { findGitRoot } from "../project/git.ts";
import { editAgentSkills } from "../config-core/agent-scope-edit.ts";
import { ConfigParseError, ScopeTargetError } from "../config-core/errors.ts";
import { AGENT_DEF_TABLE } from "../ingest/agent-def.ts";
import { AgentSourceRegistry } from "./registry.ts";
import { AgentNotFoundError } from "./errors.ts";
import type { AgentRecord, AgentScope } from "./source.ts";

/**
 * Orchestration for `ax agents` CLI subcommands. `readAllAgents` joins on-disk
 * truth (sources × scopes) with graph lifecycle status (`deleted_at`); the
 * mutate paths (rm/park/unpark) drive the source adapter; `scopeAgent` routes
 * through the SHARED agent-frontmatter editor so `ax agents scope` and
 * `ax skills scope` edit the exact same surface.
 */

export type AgentLifecycle = "live" | "deleted" | "uningested";

export interface AgentListRow {
    readonly name: string;
    readonly scope: AgentScope;
    readonly dirPath: string;
    readonly description?: string | undefined;
    readonly model?: string | undefined;
    readonly skills: readonly string[];
    readonly status: AgentLifecycle;
}

export interface AgentFilter {
    /** Restrict to one scope. */
    readonly scope?: AgentScope | undefined;
    /** Include rows tombstoned in the graph (default false → live + uningested). */
    readonly includeDeleted?: boolean;
}

interface AgentDbRow {
    readonly name: string;
    readonly deleted_at: unknown;
}

const resolveRepoRoot = (): Effect.Effect<string | undefined> =>
    Effect.promise(() => findGitRoot(process.cwd())).pipe(
        Effect.map((r) => r ?? undefined),
    );

/** Discover all on-disk agents across every source, dedup by name (user wins). */
const discoverAll = (): Effect.Effect<
    AgentRecord[],
    ConfigParseError | PlatformError,
    FileSystem.FileSystem | Path.Path | AgentSourceRegistry
> =>
    Effect.gen(function* () {
        const reg = yield* AgentSourceRegistry;
        const repoRoot = yield* resolveRepoRoot();
        const byName = new Map<string, AgentRecord>();
        for (const source of reg.all()) {
            for (const rec of yield* source.discover(repoRoot)) {
                if (!byName.has(rec.name)) byName.set(rec.name, rec);
            }
        }
        return [...byName.values()];
    });

/**
 * List agents: on-disk records annotated with graph lifecycle status, plus any
 * graph rows tombstoned/absent from disk when `includeDeleted` is set.
 */
export const readAllAgents = (
    filter: AgentFilter = {},
): Effect.Effect<
    AgentListRow[],
    ConfigParseError | PlatformError | DbError,
    SurrealClient | FileSystem.FileSystem | Path.Path | AgentSourceRegistry
> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const onDisk = yield* discoverAll();
        const [graphRows] = yield* db.query<[AgentDbRow[]]>(
            `SELECT name, deleted_at FROM ${AGENT_DEF_TABLE}`,
        );
        const deletedInGraph = new Set(
            (graphRows ?? [])
                .filter((r) => r.deleted_at != null)
                .map((r) => r.name),
        );
        const liveInGraph = new Set(
            (graphRows ?? [])
                .filter((r) => r.deleted_at == null)
                .map((r) => r.name),
        );

        const rows: AgentListRow[] = [];
        for (const rec of onDisk) {
            if (filter.scope && rec.scope !== filter.scope) continue;
            const status: AgentLifecycle = liveInGraph.has(rec.name)
                ? "live"
                : "uningested";
            rows.push({
                name: rec.name,
                scope: rec.scope,
                dirPath: rec.dirPath,
                description: rec.description,
                model: rec.model,
                skills: rec.skills,
                status,
            });
        }

        if (filter.includeDeleted) {
            const onDiskNames = new Set(onDisk.map((r) => r.name));
            for (const name of deletedInGraph) {
                if (onDiskNames.has(name)) continue;
                rows.push({
                    name,
                    scope: "user",
                    dirPath: "(deleted)",
                    skills: [],
                    status: "deleted",
                });
            }
        }

        rows.sort((a, b) => a.name.localeCompare(b.name));
        return rows;
    });

/** Resolve one agent by name from on-disk sources, failing typed if absent. */
export const findAgent = (
    name: string,
): Effect.Effect<
    AgentRecord,
    ConfigParseError | PlatformError | AgentNotFoundError,
    FileSystem.FileSystem | Path.Path | AgentSourceRegistry
> =>
    Effect.gen(function* () {
        const all = yield* discoverAll();
        const hit = all.find((a) => a.name === name);
        if (!hit) {
            return yield* new AgentNotFoundError({
                name,
                known: all.map((a) => a.name).sort(),
            });
        }
        return hit;
    });

/** Hard-delete an agent file. */
export const removeAgent = (
    name: string,
): Effect.Effect<
    AgentRecord,
    ConfigParseError | PlatformError | AgentNotFoundError,
    FileSystem.FileSystem | Path.Path | AgentSourceRegistry
> =>
    Effect.gen(function* () {
        const reg = yield* AgentSourceRegistry;
        const rec = yield* findAgent(name);
        const source = reg.all().find((s) => s.scope === rec.scope)!;
        yield* source.remove(rec);
        return rec;
    });

/** Move an agent file aside (disable, recoverable). */
export const parkAgent = (
    name: string,
): Effect.Effect<
    AgentRecord,
    ConfigParseError | PlatformError | AgentNotFoundError,
    FileSystem.FileSystem | Path.Path | AgentSourceRegistry
> =>
    Effect.gen(function* () {
        const reg = yield* AgentSourceRegistry;
        const rec = yield* findAgent(name);
        const source = reg.all().find((s) => s.scope === rec.scope)!;
        yield* source.park(rec);
        return rec;
    });

/**
 * Restore a parked agent. The parked file is `<dir>/<name>.md.ax-parked`; we
 * synthesize a record pointing at the live path and let the source rename back.
 */
export const unparkAgent = (
    name: string,
    scope: AgentScope,
    repoRoot?: string,
): Effect.Effect<
    void,
    ConfigParseError | AgentNotFoundError,
    FileSystem.FileSystem | Path.Path | AgentSourceRegistry
> =>
    Effect.gen(function* () {
        const reg = yield* AgentSourceRegistry;
        const path = yield* Path.Path;
        const source = reg.all().find((s) => s.scope === scope);
        if (!source) {
            return yield* new AgentNotFoundError({ name, known: [] });
        }
        const roots = source.roots(repoRoot ?? (yield* resolveRepoRoot()));
        const dir = roots[0];
        if (!dir) {
            return yield* new AgentNotFoundError({ name, known: [] });
        }
        const livePath = path.join(dir, `${name}.md`);
        yield* source.unpark({
            name,
            scope,
            dirPath: livePath,
            skills: [],
            contentHash: "",
            bytes: 0,
        });
    });

export interface ScopeResult {
    readonly changed: boolean;
    readonly skills: readonly string[];
    readonly agentFile: string;
}

/**
 * Add or remove a skill on an agent's `skills:` frontmatter list via the SHARED
 * editor (same surface `ax skills scope` writes). Resolves the agent's file
 * first so the caller may pass a bare agent name.
 */
export const scopeAgent = (
    agent: string,
    skill: string,
    opts: { readonly remove?: boolean } = {},
): Effect.Effect<
    ScopeResult,
    | ConfigParseError
    | AgentNotFoundError
    | ScopeTargetError
    | PlatformError,
    FileSystem.FileSystem | Path.Path | AgentSourceRegistry
> =>
    Effect.gen(function* () {
        const rec = yield* findAgent(agent);
        const result = yield* editAgentSkills(rec.dirPath, (cur) =>
            opts.remove ? cur.filter((s) => s !== skill) : [...cur, skill],
        );
        return {
            changed: result.changed,
            skills: result.skills,
            agentFile: rec.dirPath,
        };
    });
