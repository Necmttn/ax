/**
 * Stored routing-table format + IO.
 *
 * ~/.ax/hooks/routing-table.json is the live source of truth read by the
 * route-dispatch hook and `ax dispatches --candidates`. Classes carry an
 * `origin` tag: "default" rows are refreshed from ROUTING_CLASSES on every
 * `ax routing compile`; "user" rows (mined by `ax routing tune` or hand-added)
 * survive regeneration. Merge key: class id; a default id always wins.
 */
import { Effect, FileSystem, Path } from "effect";
import { homedir } from "node:os";
import { ROUTING_CLASSES, type RoutingClass, type RoutingTable } from "./dispatch-analytics.ts";

export type ClassOrigin = "default" | "user";

export interface StoredRoutingClass extends RoutingClass {
    readonly origin: ClassOrigin;
}

export interface StoredRoutingTable {
    readonly version: 1;
    readonly classes: ReadonlyArray<StoredRoutingClass>;
    readonly agentTypes: Readonly<Record<string, string>>;
}

export const defaultRoutingTablePath = (): string =>
    `${homedir()}/.ax/hooks/routing-table.json`;

/** Refresh defaults, keep user classes. Default ids always win on collision. */
export const mergeRoutingTables = (
    defaults: RoutingTable,
    existing: StoredRoutingTable | null,
): StoredRoutingTable => {
    const defaultClasses: StoredRoutingClass[] = defaults.classes.map((c) => ({
        ...c,
        origin: "default" as const,
    }));
    const defaultIds = new Set(defaultClasses.map((c) => c.id));
    const userClasses = (existing?.classes ?? []).filter(
        (c) => c.origin === "user" && !defaultIds.has(c.id),
    );
    return {
        version: 1,
        classes: [...defaultClasses, ...userClasses],
        agentTypes: { ...defaults.agentTypes, ...(existing?.agentTypes ?? {}) },
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

/** Read + parse the stored table. Null on missing file / bad JSON / bad shape. */
export const loadStoredRoutingTable = (
    path: string,
): Effect.Effect<StoredRoutingTable | null, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const text = yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => null));
        if (text === null) return null;
        try {
            const parsed = JSON.parse(text) as StoredRoutingTable;
            if (parsed?.version !== 1 || !Array.isArray(parsed.classes)) return null;
            return parsed;
        } catch {
            return null;
        }
    });

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
        if (stored === null) return ROUTING_CLASSES;
        return {
            version: 1,
            classes: stored.classes,
            agentTypes: stored.agentTypes,
        } satisfies RoutingTable;
    });
