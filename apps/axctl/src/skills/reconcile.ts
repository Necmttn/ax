import { Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { reconcileTable, type ReconcileReport } from "../config-core/reconcile.ts";
import { SkillSourceRegistry } from "./sources/registry.ts";
import type { SkillRecord } from "./sources/types.ts";

/**
 * Discover the full live on-disk skill set across every source (a SINGLE
 * snapshot - the orphan diff must not race a concurrent install), then hand the
 * names to the shared `reconcileTable("skill", …)` soft-tombstone pass:
 *   - names in DB but absent on disk -> `deleted_at = time::now()`
 *   - names present on disk          -> `deleted_at = NONE`, `last_seen_at` touched
 *
 * Soft delete preserves historical `invoked` evidence. Parse failures from a
 * single bad SKILL.md must NOT abort the whole reconcile (one corrupt skill
 * shouldn't tombstone all the others), so per-ref discovery defects are logged
 * and skipped.
 */
export const discoverAllSkills = (
    repoRoot: string | null = null,
): Effect.Effect<
    ReadonlyArray<SkillRecord>,
    never,
    SkillSourceRegistry | FileSystem.FileSystem | Path.Path
> =>
    Effect.gen(function* () {
        const registry = yield* SkillSourceRegistry;
        const records: SkillRecord[] = [];
        for (const source of registry.all()) {
            for (const ref of source.roots(repoRoot)) {
                const found = yield* source.discover(ref).pipe(
                    Effect.tapError((err) =>
                        Effect.logWarning(
                            `skills reconcile: skipping ${ref.root}: ${String(err)}`,
                        ),
                    ),
                    Effect.orElseSucceed(() => [] as ReadonlyArray<SkillRecord>),
                );
                records.push(...found);
            }
        }
        // Dedup by name (user precedes plugin in registry order, so it wins).
        const byName = new Map<string, SkillRecord>();
        for (const r of records) if (!byName.has(r.name)) byName.set(r.name, r);
        return [...byName.values()];
    });

/**
 * Run the skill tombstone reconcile against the current on-disk truth. Exposed
 * standalone (`ax skills reconcile`) AND wired at the tail of `skillsStage` so
 * every ingest self-heals.
 */
export const reconcileSkills = (
    opts?: { readonly dryRun?: boolean; readonly repoRoot?: string | null },
): Effect.Effect<
    ReconcileReport,
    DbError | PlatformError,
    SkillSourceRegistry | FileSystem.FileSystem | Path.Path | SurrealClient
> =>
    Effect.gen(function* () {
        const records = yield* discoverAllSkills(opts?.repoRoot ?? null);
        const names = records.map((r) => r.name);
        return yield* reconcileTable("skill", names, { dryRun: opts?.dryRun ?? false });
    });
