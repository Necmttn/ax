import { Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { reconcileByScope, type ScopedReconcileReport } from "../config-core/reconcile.ts";
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
export interface SkillSnapshot {
    readonly records: ReadonlyArray<SkillRecord>;
    /** False when any root failed to ENUMERATE (PlatformError) - the snapshot is
     *  degraded and must not drive destructive tombstoning. A single malformed
     *  SKILL.md (SkillParseError) is a benign per-file skip and keeps it true. */
    readonly complete: boolean;
}

export const discoverAllSkills = (
    repoRoot: string | null = null,
): Effect.Effect<
    SkillSnapshot,
    never,
    SkillSourceRegistry | FileSystem.FileSystem | Path.Path
> =>
    Effect.gen(function* () {
        const registry = yield* SkillSourceRegistry;
        const records: SkillRecord[] = [];
        let complete: boolean = true;
        const empty = [] as ReadonlyArray<SkillRecord>;
        for (const source of registry.all()) {
            for (const ref of source.roots(repoRoot)) {
                const found = yield* source.discover(ref).pipe(
                    // a corrupt SKILL.md skips just that file; snapshot stays complete
                    Effect.catchTag("SkillParseError", (err) =>
                        Effect.logWarning(`skills reconcile: bad SKILL.md under ${ref.root}: ${err.reason}`).pipe(Effect.as(empty)),
                    ),
                    // a root we cannot READ (EACCES/ENOENT) degrades the snapshot -> no tombstone
                    Effect.catchCause((cause) =>
                        Effect.sync(() => { complete = false; }).pipe(
                            Effect.andThen(Effect.logWarning(`skills reconcile: unreadable root ${ref.root}: ${String(cause)}`)),
                            Effect.as(empty),
                        ),
                    ),
                );
                records.push(...found);
            }
        }
        // Dedup by name (user precedes plugin in registry order, so it wins).
        const byName = new Map<string, SkillRecord>();
        for (const r of records) if (!byName.has(r.name)) byName.set(r.name, r);
        return { records: [...byName.values()], complete };
    });

/**
 * Run the skill tombstone reconcile against the current on-disk truth. Exposed
 * standalone (`ax skills reconcile`) AND wired at the tail of `skillsStage` so
 * every ingest self-heals.
 */
export const reconcileSkills = (
    opts?: { readonly dryRun?: boolean; readonly repoRoot?: string | null },
): Effect.Effect<
    ScopedReconcileReport,
    DbError | PlatformError,
    SkillSourceRegistry | FileSystem.FileSystem | Path.Path | SurrealClient
> =>
    Effect.gen(function* () {
        const snapshot = yield* discoverAllSkills(opts?.repoRoot ?? null);
        // Partition by scope so reconcile only touches scopes THIS discovery owns
        // (user/command/plugin:x/...); the `skill` table also holds provider tools
        // and other repos' project skills, which must never be tombstoned here.
        const byScope = new Map<string, string[]>();
        for (const rec of snapshot.records) {
            const arr = byScope.get(rec.scopeTag) ?? [];
            arr.push(rec.name);
            byScope.set(rec.scopeTag, arr);
        }
        // A degraded snapshot resurrects/touches but never tombstones.
        return yield* reconcileByScope("skill", byScope, {
            dryRun: opts?.dryRun ?? false,
            tombstone: snapshot.complete,
        });
    });
