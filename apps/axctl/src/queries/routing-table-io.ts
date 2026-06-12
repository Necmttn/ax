/**
 * Stored routing-table format + IO.
 *
 * ~/.ax/hooks/routing-table.json is the live source of truth read by the
 * route-dispatch hook and `ax dispatches --candidates`. Classes carry an
 * `origin` tag: "default" rows are refreshed from ROUTING_CLASSES on every
 * `ax routing compile`; "user" rows (mined by `ax routing tune` or hand-added)
 * survive regeneration. Merge key: class id; a default id always wins.
 *
 * agentTypes is asymmetric on merge: defaults refresh on every compile
 * (a stale stored copy never shadows an updated default), while user-ADDED
 * keys (absent from defaults) survive.
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

/**
 * What a load from disk can actually promise: legacy files (written by the
 * pre-origin `ax dispatches compile-routing`) and hand-added rows may lack
 * the origin tag. mergeRoutingTables accepts this shape and always RETURNS
 * definite origins (origin-less rows are migrated to "user").
 */
export interface LoadedRoutingClass extends RoutingClass {
    readonly origin?: ClassOrigin;
}

export interface LoadedRoutingTable {
    readonly version: 1;
    readonly classes: ReadonlyArray<LoadedRoutingClass>;
    readonly agentTypes: Readonly<Record<string, string>>;
}

export const defaultRoutingTablePath = (): string =>
    `${homedir()}/.ax/hooks/routing-table.json`;

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

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

/** Rebuild a class row from untrusted JSON; null when required fields are bad. */
const normalizeClassRow = (row: unknown): LoadedRoutingClass | null => {
    if (!isRecord(row)) return null;
    if (
        typeof row.id !== "string" ||
        typeof row.pattern !== "string" ||
        typeof row.suggest !== "string" ||
        typeof row.reason !== "string"
    ) {
        return null;
    }
    const base = {
        id: row.id,
        pattern: row.pattern,
        flags: typeof row.flags === "string" ? row.flags : "",
        suggest: row.suggest,
        reason: row.reason,
    };
    const origin = row.origin === "default" || row.origin === "user" ? row.origin : undefined;
    return origin === undefined ? base : { ...base, origin };
};

/**
 * Read + parse + normalize the stored table. Null on missing file / bad JSON /
 * bad top-level shape. Malformed class rows are dropped; a missing or
 * non-object agentTypes becomes {} (hand-edited files must not type-lie
 * downstream).
 */
export const loadStoredRoutingTable = (
    path: string,
): Effect.Effect<LoadedRoutingTable | null, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const text = yield* fs.readFileString(path).pipe(Effect.orElseSucceed(() => null));
        if (text === null) return null;
        try {
            const parsed: unknown = JSON.parse(text);
            if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.classes)) {
                return null;
            }
            const classes = parsed.classes
                .map(normalizeClassRow)
                .filter((c): c is LoadedRoutingClass => c !== null);
            const agentTypes: Record<string, string> = isRecord(parsed.agentTypes)
                ? Object.fromEntries(
                      Object.entries(parsed.agentTypes).filter(
                          (e): e is [string, string] => typeof e[1] === "string",
                      ),
                  )
                : {};
            return { version: 1, classes, agentTypes } satisfies LoadedRoutingTable;
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
