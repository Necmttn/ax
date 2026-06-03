import type { Effect, FileSystem } from "effect";
import type {
    HookConfigParseError,
    HookConfigSchemaError,
    HookValidationError,
} from "../errors.ts";

/**
 * Provider-agnostic hook model. Every provider (claude, cursor, codex,
 * opencode) declares hooks as entries inside config files across one or more
 * scopes; this module is the common vocabulary the orchestration layer
 * (`../config.ts`) and the CLI speak, independent of any on-disk schema.
 */

/** Where a config file lives relative to the agent: global (~), repo, or repo-local. */
export type HookScope = "global" | "project" | "local";

/** A concrete config file a provider reads/writes for a given scope. */
export interface HookFileRef {
    readonly path: string;
    readonly scope: HookScope;
    readonly format: "json" | "toml";
}

/** Who authored a hook, derived from its command string heuristics + markers. */
export type HookOwner = "ax" | "gsd" | "superset" | "you";

/**
 * One declared hook entry, normalized across providers. `command` is always the
 * human-readable command string; `argv` preserves the raw argv form when a
 * provider stores commands as arrays (opencode) so a round-trip is lossless.
 */
export interface ConfiguredHook {
    /** ax-marker id if present, else an 8-char content hash. Stable per entry. */
    readonly id: string;
    readonly provider: string;
    readonly scope: HookScope;
    readonly file: string;
    readonly event: string;
    /** tool/glob matcher, or null for matcher:"none" providers. */
    readonly matcher: string | null;
    readonly command: string;
    /** raw argv when the provider stores an array command; undefined otherwise. */
    readonly argv?: ReadonlyArray<string> | undefined;
    readonly timeout?: number | undefined;
    readonly enabled: boolean;
    readonly owner: HookOwner;
    /** the embedded ax marker id, if this hook is ax-owned via a marker. */
    readonly axId?: string | undefined;
}

/** A request to add a new hook. */
export interface HookInput {
    readonly event: string;
    readonly matcher?: string | null;
    readonly command: string;
    readonly timeout?: number;
}

/** A partial change to an existing hook (by id). */
export interface HookPatch {
    readonly command?: string;
    readonly matcher?: string | null;
    readonly timeout?: number;
}

/**
 * A provider adapter. Pure codec helpers may be total functions; the public
 * `parse`/`apply*` surface returns Effects so failures are typed and the
 * orchestration layer can compose them with `writeFileAtomic`.
 *
 * The `apply*` methods take the *raw current file text* and return the *new
 * raw file text* (or, for parse, the decoded entries). They never touch disk -
 * that is `../config.ts`'s job, so the same codec is trivially unit-testable
 * with no FileSystem layer.
 */
export interface HookProvider {
    readonly name: string;
    readonly label: string;
    /** valid event names for this provider. */
    readonly events: ReadonlyArray<string>;
    /** matcher discipline: tool-name match, glob match, or no matcher at all. */
    readonly matcher: "tool" | "glob" | "none";

    /** config files this provider reads for a given scope (global/project/local). */
    readonly configFiles: (scope: HookScope, repoRoot: string | null) => ReadonlyArray<HookFileRef>;
    /** cheap check: does this provider appear installed (any global config dir exists)? */
    readonly installed: (
        repoRoot: string | null,
    ) => Effect.Effect<boolean, never, FileSystem.FileSystem>;

    /** decode the raw text of one config file into normalized hook entries. */
    readonly parse: (
        ref: HookFileRef,
        raw: string,
    ) => Effect.Effect<ReadonlyArray<ConfiguredHook>, HookConfigParseError | HookConfigSchemaError>;

    /** return new file text with `input` added. `raw` may be "" for a new file. */
    readonly applyAdd: (
        ref: HookFileRef,
        raw: string,
        input: HookInput,
    ) => Effect.Effect<string, HookConfigParseError | HookConfigSchemaError | HookValidationError>;

    /** return new file text with the entry matching `id` removed. */
    readonly applyRemove: (
        ref: HookFileRef,
        raw: string,
        id: string,
    ) => Effect.Effect<string, HookConfigParseError | HookConfigSchemaError>;

    /** return new file text with the entry matching `id` patched. */
    readonly applyEdit: (
        ref: HookFileRef,
        raw: string,
        id: string,
        patch: HookPatch,
    ) => Effect.Effect<string, HookConfigParseError | HookConfigSchemaError | HookValidationError>;

    /**
     * extract the native entry object for `id` (for the park sidecar) and return
     * the file text with it removed. Returns null entry if id not present.
     */
    readonly extractEntry: (
        ref: HookFileRef,
        raw: string,
        id: string,
    ) => Effect.Effect<
        { readonly entry: unknown; readonly text: string },
        HookConfigParseError | HookConfigSchemaError
    >;

    /** re-insert a previously-extracted native entry object into the file text. */
    readonly insertEntry: (
        ref: HookFileRef,
        raw: string,
        entry: unknown,
    ) => Effect.Effect<string, HookConfigParseError | HookConfigSchemaError>;
}
