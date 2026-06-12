/**
 * Stored routing-table merge/compile/save logic.
 *
 * ~/.ax/hooks/routing-table.json is the live source of truth read by the
 * route-dispatch hook and `ax dispatches --candidates`. The table SCHEMA
 * (types + validation) and the READ path live in @ax/hooks-sdk/routing-table
 * (ADR-0014) - re-exported here for existing consumers; this module owns the
 * write side: merge, append, save.
 *
 * Classes carry an `origin` tag: "default" rows are refreshed from
 * ROUTING_CLASSES on every `ax routing compile`; "user" rows (mined by
 * `ax routing tune` or hand-added) survive regeneration. Merge key: class id;
 * a default id always wins.
 *
 * agentTypes is asymmetric on merge: defaults refresh on every compile
 * (a stale stored copy never shadows an updated default), while user-ADDED
 * keys (absent from defaults) survive.
 */
import { Effect, FileSystem, Path } from "effect";
import {
    DEFAULT_ROUTING_TABLE,
    defaultRoutingTablePath,
    loadStoredRoutingTable,
    type ClassOrigin,
    type LoadedRoutingClass,
    type LoadedRoutingTable,
    type RoutingClass,
    type RoutingTable,
} from "@ax/hooks-sdk/routing-table";

export { defaultRoutingTablePath, loadStoredRoutingTable };
export type { ClassOrigin, LoadedRoutingClass, LoadedRoutingTable };

export interface StoredRoutingClass extends RoutingClass {
    readonly origin: ClassOrigin;
}

export interface StoredRoutingTable {
    readonly version: 1;
    readonly classes: ReadonlyArray<StoredRoutingClass>;
    readonly agentTypes: Readonly<Record<string, string>>;
}

/**
 * Refresh defaults, keep user classes. Default ids always win on collision.
 * Classes: rows with origin !== "default" (i.e. "user" or legacy origin-less)
 * are preserved and tagged "user"; rows tagged "default" are replaced
 * wholesale by the current defaults (stale ones drop).
 * agentTypes: defaults overwrite stored values key-by-key (stale stored
 * copies never shadow updated defaults); user-added keys survive.
 */
export const mergeRoutingTables = (
    defaults: RoutingTable,
    existing: LoadedRoutingTable | null,
): StoredRoutingTable => {
    const defaultClasses: StoredRoutingClass[] = defaults.classes.map((c) => ({
        ...c,
        origin: "default" as const,
    }));
    const defaultIds = new Set(defaultClasses.map((c) => c.id));
    const userClasses: StoredRoutingClass[] = (existing?.classes ?? [])
        .filter((c) => c.origin !== "default" && !defaultIds.has(c.id))
        .map((c) => ({ ...c, origin: "user" as const }));
    return {
        version: 1,
        classes: [...defaultClasses, ...userClasses],
        agentTypes: { ...(existing?.agentTypes ?? {}), ...defaults.agentTypes },
    };
};

/** Append mined classes as origin: user, deduping by id (first wins). */
export const appendUserClasses = (
    table: StoredRoutingTable,
    additions: ReadonlyArray<StoredRoutingClass>,
): StoredRoutingTable => {
    const seen = new Set(table.classes.map((c) => c.id));
    const fresh: StoredRoutingClass[] = [];
    for (const a of additions) {
        if (seen.has(a.id)) continue;
        seen.add(a.id);
        fresh.push({ ...a, origin: "user" });
    }
    return { ...table, classes: [...table.classes, ...fresh] };
};

export const saveStoredRoutingTable = (
    path: string,
    table: StoredRoutingTable,
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const p = yield* Path.Path;
        yield* fs.makeDirectory(p.dirname(path), { recursive: true }).pipe(Effect.orDie);
        yield* fs.writeFileString(path, JSON.stringify(table, null, 2)).pipe(Effect.orDie);
    });

/**
 * The table the rest of the loop should match against: stored file if valid,
 * else built-in defaults. Same fail-open semantics as the route-dispatch hook.
 */
export const loadEffectiveRoutingTable = (
    path?: string,
): Effect.Effect<RoutingTable, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const stored = yield* loadStoredRoutingTable(path ?? defaultRoutingTablePath());
        if (stored === null) return DEFAULT_ROUTING_TABLE;
        return {
            version: 1,
            classes: stored.classes,
            agentTypes: stored.agentTypes,
        } satisfies RoutingTable;
    });
