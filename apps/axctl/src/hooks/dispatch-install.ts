import { Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import type { DbError } from "@ax/lib/errors";
import type { SurrealClient } from "@ax/lib/db";
import { dispatchInstallPlan } from "@ax/hooks-sdk/dispatch";
import { GUARD_NAMES, DISPATCHER_NAME, SHIM_NAME } from "./guard-names.ts";
import { addHook, readAllHooks, removeHook } from "./config.ts";
import { HookProviderRegistry } from "./providers/registry.ts";
import {
    filterAlreadyInstalled,
    stripAxMarker,
    type InstallPlanEntry,
    type InstalledHookKey,
} from "./sdk-install.ts";
import type { HookScope } from "./providers/types.ts";

/**
 * Install the SINGLE dispatcher instead of N per-guard hooks, and migrate any
 * legacy per-guard entries away. The dispatcher is registered once per
 * (provider, event) - tool matchers UNION-ed per event via `dispatchInstallPlan`
 * so it only fires on tools a guard actually claims - and fires as
 * `bun <dir>/dispatch.{ts,js}`, multiplexing every guard in one process.
 *
 * The pure planning (`planDispatcherInstall`, `planLegacyRemoval`) is split out
 * so it unit-tests without a DB; only `installDispatcher` touches the config
 * files + the evidence DB.
 */

// ---------------------------------------------------------------------------
// Pure planning
// ---------------------------------------------------------------------------

/**
 * Fan the dispatcher's per-event plan across providers. command = `bun
 * <dispatchPath>`; matcher = the event's tool union joined with "|", or null
 * (no filter) for events no guard scopes by tool (e.g. SessionStart).
 */
export const planDispatcherInstall = (
    dispatchPath: string,
    providers: ReadonlyArray<string>,
): InstallPlanEntry[] =>
    providers.flatMap((provider) =>
        dispatchInstallPlan().map((entry) => ({
            provider,
            input: {
                event: entry.event,
                matcher: entry.tools && entry.tools.length > 0 ? entry.tools.join("|") : null,
                command: `bun ${dispatchPath}`,
                timeout: 10,
            },
        })),
    );

/** Every command string a legacy per-guard install could have written for a
 *  workspace dir: `bun <dir>/<guard>.ts` and `.js`, for each guard. */
export const legacyGuardCommands = (dir: string): ReadonlySet<string> => {
    const cmds = new Set<string>();
    for (const guard of GUARD_NAMES) {
        cmds.add(`bun ${dir}/${guard}.ts`);
        cmds.add(`bun ${dir}/${guard}.js`);
    }
    return cmds;
};

/** Commands in the dispatcher "family" - the dispatcher AND the shim, either
 *  extension. Switching between `--all` (dispatch) and `--all --daemon` (shim)
 *  must remove the OTHER family entry so they don't double-fire. */
export const dispatcherFamilyCommands = (dir: string): ReadonlySet<string> => {
    const cmds = new Set<string>();
    for (const name of [DISPATCHER_NAME, SHIM_NAME]) {
        cmds.add(`bun ${dir}/${name}.ts`);
        cmds.add(`bun ${dir}/${name}.js`);
    }
    return cmds;
};

/** A configured hook row, narrowed to the fields migration needs. */
export interface ConfiguredHookRow {
    readonly provider: string;
    readonly scope: string;
    readonly event: string;
    readonly command: string;
    readonly id: string;
    readonly file?: string | undefined;
    /** the ` # ax:<id>` marker id; present only on ax-owned entries. */
    readonly axId?: string | undefined;
}

/**
 * Pure: which existing entries to remove when (re)pointing the dispatcher. ONLY
 * ax-owned rows (an `axId` marker), on a target provider + scope, whose
 * marker-stripped command is either a legacy per-guard command OR a
 * dispatcher-family command (dispatch / dispatch-shim) for THIS dir - EXCEPT the
 * `keepCommand` being installed now. So a fresh guard->dispatcher migration AND
 * a dispatch<->shim switch both clean up, while re-running the same install is a
 * no-op. A user's own hand-written hook (no axId) is never touched.
 */
export const planLegacyRemoval = (
    existing: ReadonlyArray<ConfiguredHookRow>,
    dir: string,
    providers: ReadonlyArray<string>,
    scope: string,
    keepCommand?: string,
): ConfiguredHookRow[] => {
    const removable = new Set<string>([
        ...legacyGuardCommands(dir),
        ...dispatcherFamilyCommands(dir),
    ]);
    if (keepCommand) removable.delete(keepCommand);
    return existing.filter(
        (h) =>
            h.axId !== undefined &&
            h.axId !== null &&
            providers.includes(h.provider) &&
            h.scope === scope &&
            removable.has(stripAxMarker(h.command)),
    );
};

// ---------------------------------------------------------------------------
// resolveDispatcherPath
// ---------------------------------------------------------------------------

/** The scaffolded dispatcher entry in `dir`: prefer `dispatch.ts` (source),
 *  else `dispatch.js` (compiled-binary bundle), else null. */
export const resolveDispatcherPath = (
    dir: string,
): Effect.Effect<string | null, PlatformError, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const pathSvc = yield* Path.Path;
        const tsPath = pathSvc.join(dir, `${DISPATCHER_NAME}.ts`);
        if (yield* fs.exists(tsPath)) return tsPath;
        const jsPath = pathSvc.join(dir, `${DISPATCHER_NAME}.js`);
        if (yield* fs.exists(jsPath)) return jsPath;
        return null;
    });

/** The scaffolded daemon shim in `dir`: prefer `dispatch-shim.ts`, else `.js`,
 *  else null. */
export const resolveShimPath = (
    dir: string,
): Effect.Effect<string | null, PlatformError, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const pathSvc = yield* Path.Path;
        const tsPath = pathSvc.join(dir, `${SHIM_NAME}.ts`);
        if (yield* fs.exists(tsPath)) return tsPath;
        const jsPath = pathSvc.join(dir, `${SHIM_NAME}.js`);
        if (yield* fs.exists(jsPath)) return jsPath;
        return null;
    });

// ---------------------------------------------------------------------------
// installDispatcher (Effect: config + DB)
// ---------------------------------------------------------------------------

export interface DispatcherInstallResult {
    readonly entries: ReadonlyArray<InstallPlanEntry & { readonly skipped: boolean; readonly writtenPath?: string }>;
    readonly removed: ReadonlyArray<ConfiguredHookRow>;
}

/**
 * Register the dispatcher (idempotent) and migrate off legacy per-guard
 * entries. Reads existing hooks once, skips dispatcher entries already present,
 * adds the rest, then removes ax-owned legacy per-guard rows so guards don't
 * double-fire.
 */
export const installDispatcher = (
    dispatchPath: string,
    dir: string,
    providers: ReadonlyArray<string>,
    scope: HookScope,
    opts: { readonly repoRoot?: string | null | undefined } = {},
): Effect.Effect<
    DispatcherInstallResult,
    PlatformError | DbError | import("./errors.ts").HookConfigParseError | import("./errors.ts").HookConfigSchemaError | import("./errors.ts").HookValidationError | import("./errors.ts").HookProviderNotFoundError | import("./errors.ts").HookNotFoundError,
    HookProviderRegistry | FileSystem.FileSystem | Path.Path | SurrealClient
> =>
    Effect.gen(function* () {
        const existing = yield* readAllHooks({
            scopeFilter: scope,
            withEvidence: false,
            repoRoot: opts.repoRoot,
        });

        const plan = planDispatcherInstall(dispatchPath, providers);
        const annotated = filterAlreadyInstalled(plan, existing as ReadonlyArray<InstalledHookKey>, scope);

        const entries: Array<InstallPlanEntry & { skipped: boolean; writtenPath?: string }> = [];
        for (const entry of annotated) {
            if (entry.skipped) {
                entries.push({ ...entry });
                continue;
            }
            const writtenPath = yield* addHook({
                provider: entry.provider,
                scope,
                repoRoot: opts.repoRoot,
                input: entry.input,
            });
            entries.push({ ...entry, writtenPath });
        }

        // Migration: drop ax-owned legacy per-guard entries AND the other
        // dispatcher-family command (so a dispatch<->shim switch doesn't
        // double-fire); never the one just installed.
        const toRemove = planLegacyRemoval(
            existing as ReadonlyArray<ConfiguredHookRow>,
            dir,
            providers,
            scope,
            `bun ${dispatchPath}`,
        );
        const removed: ConfiguredHookRow[] = [];
        for (const h of toRemove) {
            yield* removeHook({ provider: h.provider, scope, file: h.file, id: h.id, repoRoot: opts.repoRoot });
            removed.push(h);
        }

        return { entries, removed };
    });
