import { Effect, FileSystem, Path, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { CacheRead, type CacheReadError, type CacheWriteError } from "@ax/lib/duckdb/seam";
import { NumberFromBigIntColumn, TimestampColumn } from "@ax/lib/duckdb/columns";
import { editAgentSkills } from "../config-core/agent-scope-edit.ts";
import type { ConfigParseError, ScopeTargetError } from "../config-core/errors.ts";
import { loadAgentScopeMap } from "../ingest/agent-scope.ts";
import { discoverAllSkills } from "./reconcile.ts";
import { SkillSourceRegistry } from "./sources/registry.ts";
import type { SkillRecord, SkillScope } from "./sources/types.ts";
import { SkillNotFoundError } from "./errors.ts";
import { withConfigWrite } from "../config-core/reconcile.ts";
import type { AxConfig } from "@ax/lib/config";

/** Lifecycle status of a skill row vs its on-disk + parked state. */
export type SkillStatus = "live" | "orphan" | "out-of-scope" | "parked";

export interface SkillConfigRow {
    readonly name: string;
    readonly source: SkillScope | "unknown";
    readonly scopeTag: string;
    readonly dirPath: string | null;
    readonly unit: "dir" | "md" | null;
    readonly description: string | undefined;
    readonly roles: ReadonlyArray<string>;
    readonly agents: ReadonlyArray<string>;
    readonly fired: number;
    readonly lastUsed: string | null;
    readonly status: SkillStatus;
    readonly writable: boolean;
    readonly deleted: boolean;
}

export interface ReadSkillsFilter {
    readonly source?: string | undefined;
    readonly scope?: string | undefined;
    readonly status?: SkillStatus | undefined;
    /** Include rows whose DB record is tombstoned (`deleted_at` set). */
    readonly includeDeleted?: boolean;
    /** Include `out-of-scope` rows (other repos' skills, provider tools). */
    readonly includeOutOfScope?: boolean;
    readonly repoRoot?: string | null;
}

interface EvidenceRow {
    readonly name: string;
    readonly scope: string;
    readonly dir_path: string | null;
    readonly description: string | null;
    readonly fired: number;
    readonly last_used: string | null;
    readonly deleted_at: string | null;
}

/** DB evidence per skill name: invocation count + last use + tombstone state. */
const EvidenceDbRow = Schema.Struct({
    name: Schema.String, scope: Schema.String, dir_path: Schema.NullOr(Schema.String),
    description: Schema.NullOr(Schema.String), fired: NumberFromBigIntColumn,
    last_used: Schema.NullOr(TimestampColumn), deleted_at: Schema.NullOr(TimestampColumn),
});

const fetchEvidence = (): Effect.Effect<Map<string, EvidenceRow>, CacheReadError, CacheRead> =>
    Effect.gen(function* () {
        const read = yield* CacheRead;
        const rows = yield* read.rows(EvidenceDbRow,
            `SELECT
                s.name, s.scope, s.dir_path, s.description, s.deleted_at,
                count(i.id) AS fired, max(i.ts) AS last_used
            FROM skill s LEFT JOIN invoked i ON i.out_id = s.id
            GROUP BY s.name, s.scope, s.dir_path, s.description, s.deleted_at`,
        );
        const out = new Map<string, EvidenceRow>();
        for (const r of rows) {
            const name = r.name;
            out.set(name, {
                name,
                scope: r.scope,
                dir_path: r.dir_path,
                description: r.description,
                fired: r.fired,
                last_used: r.last_used?.toISOString() ?? null,
                deleted_at: r.deleted_at?.toISOString() ?? null,
            });
        }
        return out;
    });

/**
 * Unified skill lifecycle view: every on-disk record joined with DB evidence,
 * agent-scope bindings, and lifecycle status. Tombstoned-but-not-on-disk rows
 * surface as `orphan` only when `includeDeleted` is set (otherwise hidden, like
 * the read-query default filter).
 */
export const readAllSkills = (
    filter: ReadSkillsFilter = {},
): Effect.Effect<
    ReadonlyArray<SkillConfigRow>,
    CacheReadError,
    SkillSourceRegistry | FileSystem.FileSystem | Path.Path | CacheRead
> =>
    Effect.gen(function* () {
        // independent reads (disk discovery, DB evidence, agent-scope map) run concurrently.
        const [{ records }, evidence, scopeMap] = yield* Effect.all(
            [discoverAllSkills(filter.repoRoot ?? null), fetchEvidence(), loadAgentScopeMap()],
            { concurrency: 3 },
        );

        const onDisk = new Set(records.map((r) => r.name));
        // Scopes the current discovery actually owns. A DB row outside these
        // (another repo's project skills, provider tools, unknown) is not a
        // deletion - it's just out-of-context, so it must NOT read as "orphan".
        const ownedScopes = new Set(records.map((r) => r.scopeTag));
        const rows: SkillConfigRow[] = [];

        // (1) on-disk records (live)
        for (const rec of records) {
            const ev = evidence.get(rec.name);
            rows.push({
                name: rec.name,
                source: rec.source,
                scopeTag: rec.scopeTag,
                dirPath: rec.dirPath,
                unit: rec.unit,
                description: rec.description ?? ev?.description ?? undefined,
                roles: rec.roles,
                agents: scopeMap.get(rec.name) ?? [],
                fired: ev?.fired ?? 0,
                lastUsed: ev?.last_used ?? null,
                status: "live",
                writable: rec.writable,
                deleted: false,
            });
        }

        // (2) DB rows with no on-disk record: `orphan` when the scope IS owned by
        // this discovery (a real deletion, reconcile-able), else `out-of-scope`.
        for (const ev of evidence.values()) {
            if (onDisk.has(ev.name)) continue;
            rows.push({
                name: ev.name,
                source: "unknown",
                scopeTag: ev.scope,
                dirPath: ev.dir_path,
                unit: null,
                description: ev.description ?? undefined,
                roles: [],
                agents: scopeMap.get(ev.name) ?? [],
                fired: ev.fired,
                lastUsed: ev.last_used,
                status: ownedScopes.has(ev.scope) ? "orphan" : "out-of-scope",
                writable: false,
                deleted: ev.deleted_at != null,
            });
        }

        return rows
            .filter((r) => (r.deleted ? filter.includeDeleted === true : true))
            // out-of-scope rows (other repos / tools) are hidden unless asked for,
            // OR when the user explicitly filtered to status=out-of-scope.
            .filter((r) =>
                r.status === "out-of-scope"
                    ? filter.includeOutOfScope === true || filter.status === "out-of-scope"
                    : true,
            )
            .filter((r) => (filter.source ? r.source === filter.source : true))
            .filter((r) => (filter.scope ? r.scopeTag === filter.scope : true))
            .filter((r) => (filter.status ? r.status === filter.status : true))
            .sort((a, b) => a.name.localeCompare(b.name));
    });

/** Locate a single on-disk record by name across all sources. Ambiguity (same
 *  name in multiple sources) and misses both surface as `SkillNotFoundError`. */
const findRecord = (
    name: string,
    repoRoot: string | null,
): Effect.Effect<
    SkillRecord,
    SkillNotFoundError,
    SkillSourceRegistry | FileSystem.FileSystem | Path.Path
> =>
    Effect.gen(function* () {
        const { records } = yield* discoverAllSkills(repoRoot);
        const matches = records.filter((r) => r.name === name);
        if (matches.length === 1) return matches[0]!;
        return yield* new SkillNotFoundError({
            name,
            candidates: matches.map((m) => `${m.source}:${m.name}`),
        });
    });

/** Tombstone a skill's DB row by name (soft delete; keeps `invoked` history). */
const tombstone = (name: string): Effect.Effect<void, CacheWriteError, FileSystem.FileSystem | Path.Path | AxConfig> =>
    withConfigWrite((write) => write.exec(
        "UPDATE skill SET deleted_at = current_timestamp WHERE name = ? AND deleted_at IS NULL",
        [name],
    )).pipe(Effect.asVoid);

/**
 * Remove a skill on disk (writable source only) + tombstone its DB row. The
 * source adapter fails with `SkillReadOnlyError` for plugin/.system BEFORE any
 * disk touch.
 */
export const removeSkill = (
    name: string,
    opts?: { readonly repoRoot?: string | null },
) =>
    Effect.gen(function* () {
        const registry = yield* SkillSourceRegistry;
        const rec = yield* findRecord(name, opts?.repoRoot ?? null);
        const source = yield* registry.select(rec.source);
        yield* source.remove(rec);
        yield* tombstone(name);
    });

/** Move a skill dir/file aside into `.ax-parked/` (out of discovery). */
export const parkSkill = (
    name: string,
    opts?: { readonly repoRoot?: string | null },
) =>
    Effect.gen(function* () {
        const registry = yield* SkillSourceRegistry;
        const rec = yield* findRecord(name, opts?.repoRoot ?? null);
        const source = yield* registry.select(rec.source);
        yield* source.park(rec);
        yield* tombstone(name);
    });

/**
 * Restore a parked skill back into discovery. Caller supplies the source name
 * (a parked record is not discoverable, so it can't be auto-resolved). Picks
 * the first writable root for that source.
 */
export const unparkSkill = (
    name: string,
    sourceName: SkillScope,
    opts?: { readonly repoRoot?: string | null },
) =>
    Effect.gen(function* () {
        const registry = yield* SkillSourceRegistry;
        const source = yield* registry.select(sourceName);
        const ref = (yield* source.roots(opts?.repoRoot ?? null)).find((r) => r.writable);
        if (!ref) {
            return yield* new SkillNotFoundError({ name, candidates: [] });
        }
        yield* source.unpark(name, ref);
    });

/**
 * Edit a skill↔agent binding via the SHARED `editAgentSkills` frontmatter
 * editor (atomic + `.bak`). `agentFile` is the resolved path to the agent
 * definition. `remove:true` detaches; default attaches.
 */
export const scopeSkill = (
    skill: string,
    agentFile: string,
    opts?: { readonly remove?: boolean },
): Effect.Effect<
    { changed: boolean; skills: string[] },
    PlatformError | ScopeTargetError | ConfigParseError,
    FileSystem.FileSystem | Path.Path
> =>
    editAgentSkills(agentFile, (cur) =>
        opts?.remove ? cur.filter((s) => s !== skill) : [...cur, skill],
    );
