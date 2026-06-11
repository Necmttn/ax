import { Effect, Schema } from "effect";
import type { HookInput, HookScope } from "./providers/types.ts";
import { addHook, readAllHooks } from "./config.ts";
import type {
    HookConfigParseError,
    HookConfigSchemaError,
    HookValidationError,
    HookProviderNotFoundError,
} from "./errors.ts";
import type { PlatformError } from "effect/PlatformError";
import type { DbError } from "@ax/lib/errors";
import type { SurrealClient } from "@ax/lib/db";
import { FileSystem, Path } from "effect";
import { HookProviderRegistry } from "./providers/registry.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SdkHookImportError extends Schema.TaggedErrorClass<SdkHookImportError>(
    "SdkHookImportError",
)("SdkHookImportError", {
    file: Schema.String,
    reason: Schema.String,
}) {}

export class SdkHookValidationError extends Schema.TaggedErrorClass<SdkHookValidationError>(
    "SdkHookValidationError",
)("SdkHookValidationError", {
    file: Schema.String,
    reason: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// Structural types (no SDK import needed - duck typed)
// ---------------------------------------------------------------------------

/** Subset of HookDefinition that install needs (structural). */
export interface InstallableHookMeta {
    readonly name: string;
    readonly events: ReadonlyArray<string>;
    readonly matcher?: { readonly tools?: ReadonlyArray<string> } | undefined;
}

export interface InstallPlanEntry {
    readonly provider: string;
    readonly input: HookInput;
}

// ---------------------------------------------------------------------------
// Pure: plan fan-out
// ---------------------------------------------------------------------------

/**
 * Pure: fan out provider x event combinations into install plan entries.
 * command = `bun <absFile>`, matcher = tools joined with "|" (or null).
 * timeout = 10 seconds (Claude's hook timeout is per invocation).
 */
export const planInstall = (
    def: InstallableHookMeta,
    absFile: string,
    providers: ReadonlyArray<string>,
): InstallPlanEntry[] =>
    providers.flatMap((provider) =>
        def.events.map((event) => ({
            provider,
            input: {
                event,
                matcher: def.matcher?.tools?.length ? def.matcher.tools.join("|") : null,
                command: `bun ${absFile}`,
                timeout: 10,
            } satisfies HookInput,
        })),
    );

// ---------------------------------------------------------------------------
// loadHookMeta: import + validate (testable without DB)
// ---------------------------------------------------------------------------

/**
 * Dynamically import a hook file and validate its default export.
 * Returns the InstallableHookMeta on success, typed errors on failure.
 * Exported separately so tests can unit-test it without needing a DB layer.
 */
export const loadHookMeta = (
    file: string,
): Effect.Effect<InstallableHookMeta, SdkHookImportError | SdkHookValidationError> =>
    Effect.gen(function* () {
        const mod = yield* Effect.tryPromise({
            try: () => import(file),
            catch: (e) =>
                new SdkHookImportError({
                    file,
                    reason: `dynamic import failed: ${String(e)}`,
                }),
        });

        const def: unknown = mod?.default;

        if (def === null || def === undefined) {
            return yield* new SdkHookValidationError({
                file,
                reason: "no default export found",
            });
        }

        if (typeof def !== "object") {
            return yield* new SdkHookValidationError({
                file,
                reason: `default export must be an object, got ${typeof def}`,
            });
        }

        const obj = def as Record<string, unknown>;

        if (typeof obj["name"] !== "string" || !obj["name"]) {
            return yield* new SdkHookValidationError({
                file,
                reason: "default export must have a non-empty string 'name' field",
            });
        }

        if (!Array.isArray(obj["events"]) || (obj["events"] as unknown[]).length === 0) {
            return yield* new SdkHookValidationError({
                file,
                reason: "default export must have a non-empty 'events' array",
            });
        }

        const events = obj["events"] as unknown[];
        for (const ev of events) {
            if (typeof ev !== "string") {
                return yield* new SdkHookValidationError({
                    file,
                    reason: `events array must contain strings, found: ${typeof ev}`,
                });
            }
        }

        // Optional matcher
        let matcher: InstallableHookMeta["matcher"] | undefined;
        if (obj["matcher"] !== undefined && obj["matcher"] !== null) {
            const m = obj["matcher"] as Record<string, unknown>;
            if (Array.isArray(m["tools"])) {
                matcher = { tools: m["tools"] as string[] };
            } else {
                matcher = {};
            }
        }

        return {
            name: obj["name"] as string,
            events: obj["events"] as string[],
            matcher,
        } satisfies InstallableHookMeta;
    });

// ---------------------------------------------------------------------------
// Pure: idempotency filter
// ---------------------------------------------------------------------------

/** The fields of an existing configured hook the idempotency check needs. */
export interface InstalledHookKey {
    readonly provider: string;
    readonly scope: string;
    readonly event: string;
    /** as stored on disk - may carry a trailing ` # ax:<id>` marker. */
    readonly command: string;
}

/** Strip a trailing ` # ax:<id>` ownership marker (providers embed one on
 *  write, so the stored command differs from the requested one). */
const stripAxMarker = (command: string): string =>
    command.replace(/\s*#\s*ax:[a-z0-9_-]+\s*$/, "");

export interface InstallResult extends InstallPlanEntry {
    /** true when an identical (provider, scope, event, command) hook already exists. */
    readonly skipped: boolean;
    /** config file written; undefined when skipped. */
    readonly writtenPath?: string | undefined;
}

/**
 * Pure: annotate each plan entry with `skipped: true` when a hook with the
 * same (provider, scope, event, command) already exists. Commands are compared
 * marker-stripped, since providers embed ` # ax:<id>` on write.
 */
export const filterAlreadyInstalled = (
    plan: ReadonlyArray<InstallPlanEntry>,
    existing: ReadonlyArray<InstalledHookKey>,
    scope: HookScope,
): Array<InstallPlanEntry & { readonly skipped: boolean }> => {
    const key = (provider: string, sc: string, event: string, command: string): string =>
        [provider, sc, event, stripAxMarker(command)].join("\u0000");
    const seen = new Set(existing.map((e) => key(e.provider, e.scope, e.event, e.command)));
    return plan.map((entry) => ({
        ...entry,
        skipped: seen.has(key(entry.provider, scope, entry.input.event, entry.input.command)),
    }));
};

// ---------------------------------------------------------------------------
// installHookFile: main Effect
// ---------------------------------------------------------------------------

export interface InstallHookFileOptions {
    /** repo root override for project/local scope resolution (tests). */
    readonly repoRoot?: string | null | undefined;
}

/**
 * Import hook module, validate default export, apply plan via addHook.
 * Idempotent: entries whose (provider, scope, event, command) already exist in
 * the target configs are skipped, so re-running install is safe.
 * Returns the plan entries annotated with `skipped` + the file path written.
 */
export const installHookFile = (
    file: string,
    providers: ReadonlyArray<string>,
    scope: HookScope,
    opts: InstallHookFileOptions = {},
): Effect.Effect<
    ReadonlyArray<InstallResult>,
    | SdkHookImportError
    | SdkHookValidationError
    | PlatformError
    | DbError
    | HookConfigParseError
    | HookConfigSchemaError
    | HookValidationError
    | HookProviderNotFoundError,
    HookProviderRegistry | FileSystem.FileSystem | Path.Path | SurrealClient
> =>
    Effect.gen(function* () {
        if (!file.startsWith("/")) {
            return yield* new SdkHookValidationError({
                file,
                reason: "hook file path must be absolute",
            });
        }

        const meta = yield* loadHookMeta(file);
        const plan = planInstall(meta, file, providers);

        // Idempotency: skip entries already present in the target configs.
        const existing = yield* readAllHooks({
            scopeFilter: scope,
            withEvidence: false,
            repoRoot: opts.repoRoot,
        });
        const annotated = filterAlreadyInstalled(plan, existing, scope);

        const results: InstallResult[] = [];
        for (const entry of annotated) {
            if (entry.skipped) {
                results.push({ ...entry, writtenPath: undefined });
                continue;
            }
            const writtenPath = yield* addHook({
                provider: entry.provider,
                scope,
                repoRoot: opts.repoRoot,
                input: entry.input,
            });
            results.push({ ...entry, writtenPath });
        }

        return results;
    });
