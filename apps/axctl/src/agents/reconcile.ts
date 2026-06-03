import { Effect, FileSystem, Path } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { DbError } from "@ax/lib/errors";
import { findGitRoot } from "../project/git.ts";
import {
    reconcileTable,
    type ReconcileReport,
} from "../config-core/reconcile.ts";
import { AGENT_DEF_TABLE } from "../ingest/agent-def.ts";
import { AgentSourceRegistry } from "./registry.ts";

/**
 * Standalone agent reconcile (the `ax agents reconcile` path): discover the
 * on-disk agent names across all sources, then soft-tombstone DB rows that no
 * longer exist and resurrect/touch the ones that do. Same engine the
 * `agentDefStage` tail runs - this is the on-demand door.
 */
export const reconcileAgents = (
    opts?: { readonly dryRun?: boolean },
): Effect.Effect<
    ReconcileReport,
    DbError,
    SurrealClient | FileSystem.FileSystem | Path.Path | AgentSourceRegistry
> =>
    Effect.gen(function* () {
        const reg = yield* AgentSourceRegistry;
        const repoRoot = (yield* Effect.promise(() => findGitRoot(process.cwd()))) ?? undefined;
        const names = new Set<string>();
        for (const source of reg.all()) {
            const recs = yield* source.discover(repoRoot).pipe(
                Effect.mapError(
                    (e) =>
                        new DbError({
                            operation: "query",
                            message: `agent discover failed: ${e._tag === "ConfigParseError" ? e.reason : String(e)}`,
                            ...(e._tag === "ConfigParseError" ? { sql: e.file } : {}),
                        }),
                ),
            );
            for (const rec of recs) names.add(rec.name);
        }
        return yield* reconcileTable(AGENT_DEF_TABLE, [...names], opts);
    });
