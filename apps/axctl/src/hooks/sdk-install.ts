import { Effect, Schema } from "effect";
import type { HookInput, HookScope } from "./providers/types.ts";
import { addHook } from "./config.ts";
import type {
    HookConfigParseError,
    HookConfigSchemaError,
    HookValidationError,
    HookProviderNotFoundError,
} from "./errors.ts";
import type { PlatformError } from "effect/PlatformError";
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
// installHookFile: main Effect
// ---------------------------------------------------------------------------

/**
 * Import hook module, validate default export, apply plan via addHook.
 * Returns the plan entries with the resolved file path written for each.
 */
export const installHookFile = (
    file: string,
    providers: ReadonlyArray<string>,
    scope: HookScope,
): Effect.Effect<
    ReadonlyArray<InstallPlanEntry & { readonly writtenPath: string }>,
    | SdkHookImportError
    | SdkHookValidationError
    | PlatformError
    | HookConfigParseError
    | HookConfigSchemaError
    | HookValidationError
    | HookProviderNotFoundError,
    HookProviderRegistry | FileSystem.FileSystem | Path.Path
> =>
    Effect.gen(function* () {
        const meta = yield* loadHookMeta(file);
        const plan = planInstall(meta, file, providers);

        const results: Array<InstallPlanEntry & { readonly writtenPath: string }> = [];
        for (const entry of plan) {
            const writtenPath = yield* addHook({
                provider: entry.provider,
                scope,
                input: entry.input,
            });
            results.push({ ...entry, writtenPath });
        }

        return results;
    });
