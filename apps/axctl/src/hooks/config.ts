import { Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { writeFileAtomic } from "@ax/lib/atomic-write";
import { findGitRoot } from "../project/git.ts";
import { queryHookSummary } from "../queries/hooks.ts";
import { HookProviderRegistry } from "./providers/registry.ts";
import {
    HookConfigParseError,
    HookConfigSchemaError,
    HookNotFoundError,
    HookProviderNotFoundError,
    HookValidationError,
} from "./errors.ts";
import { AdapterNotFoundError } from "../config-core/errors.ts";
import type {
    ConfiguredHook,
    HookFileRef,
    HookInput,
    HookPatch,
    HookProvider,
    HookScope,
} from "./providers/types.ts";

/**
 * Orchestration for the hooks "config front door". Reads/writes provider config
 * files via the registry + `writeFileAtomic`, and joins on-disk hook
 * declarations with fired-count evidence from `hook_command_invocation`.
 *
 * Pure codec logic lives in the providers; this layer owns the FileSystem and
 * DB seams (deps: HookProviderRegistry | FileSystem | Path | SurrealClient).
 */

const SCOPES: ReadonlyArray<HookScope> = ["global", "project", "local"];

/** A ConfiguredHook with its fired-count evidence joined in. */
export interface ConfiguredHookWithEvidence extends ConfiguredHook {
    /** total fired invocations whose command string matches exactly. undefined if not requested. */
    readonly fired?: number;
    readonly lastSeen?: Date | string;
}

export interface ReadOptions {
    readonly providerFilter?: string | undefined;
    readonly scopeFilter?: HookScope | undefined;
    readonly eventFilter?: string | undefined;
    readonly withEvidence?: boolean | undefined;
    readonly repoRoot?: string | null | undefined;
}

const resolveRepoRoot = (
    override: string | null | undefined,
): Effect.Effect<string | null, never, FileSystem.FileSystem> =>
    override !== undefined ? Effect.succeed(override) : findGitRoot(process.cwd());

/** Read a config file's text, returning "" when the file does not exist. */
const readMaybe = (
    path: string,
): Effect.Effect<string, PlatformError, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        if (!(yield* fs.exists(path))) return "";
        return yield* fs.readFileString(path);
    });

interface ParkedEntry {
    readonly hook: ConfiguredHook;
    readonly entry: unknown;
}
const parkedPath = (file: string): string => `${file}.ax-parked.json`;

/** Load the park sidecar entries, or [] when absent. A corrupt sidecar is a
 *  typed `HookConfigParseError` (not a silent drop - that would hide disabled
 *  hooks). */
const readParked = (
    file: string,
): Effect.Effect<ReadonlyArray<ParkedEntry>, PlatformError | HookConfigParseError, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = parkedPath(file);
        if (!(yield* fs.exists(path))) return [];
        const raw = yield* fs.readFileString(path);
        if (raw.trim() === "") return [];
        return yield* Effect.try({
            try: () => JSON.parse(raw) as ReadonlyArray<ParkedEntry>,
            catch: (e) => new HookConfigParseError({ provider: "ax", file: path, reason: `corrupt park sidecar: ${String(e)}` }),
        });
    });

const writeParked = (
    file: string,
    entries: ReadonlyArray<ParkedEntry>,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path> =>
    writeFileAtomic(parkedPath(file), `${JSON.stringify(entries, null, 2)}\n`);

/**
 * Read every declared hook across the selected providers/scopes/files.
 * When `withEvidence` is set, joins fired counts from `queryHookSummary`
 * (matched by exact command string).
 */
export const readAllHooks = (
    opts: ReadOptions = {},
): Effect.Effect<
    ReadonlyArray<ConfiguredHookWithEvidence>,
    PlatformError | HookConfigParseError | HookConfigSchemaError | DbError,
    HookProviderRegistry | FileSystem.FileSystem | Path.Path | SurrealClient
> =>
    Effect.gen(function* () {
        const registry = yield* HookProviderRegistry;
        const repoRoot = yield* resolveRepoRoot(opts.repoRoot);
        const providers = opts.providerFilter
            ? registry.all().filter((p) => p.name === opts.providerFilter)
            : registry.all();
        const scopes = opts.scopeFilter ? [opts.scopeFilter] : SCOPES;

        const collected: ConfiguredHook[] = [];
        for (const provider of providers) {
            for (const scope of scopes) {
                for (const ref of provider.configFiles(scope, repoRoot)) {
                    const raw = yield* readMaybe(ref.path);
                    const liveIds = new Set<string>();
                    if (raw.trim() !== "") {
                        const rows = yield* provider.parse(ref, raw);
                        for (const r of rows) { liveIds.add(r.id); collected.push(r); }
                    }
                    // parked entries surface as enabled:false rows - but skip any id
                    // that is ALSO live in the config (a partial-failure leftover), so
                    // a hook never appears twice.
                    const parked = yield* readParked(ref.path);
                    for (const p of parked) if (!liveIds.has(p.hook.id)) collected.push({ ...p.hook, enabled: false });
                }
            }
        }

        const filtered = opts.eventFilter
            ? collected.filter((h) => h.event === opts.eventFilter)
            : collected;

        if (!opts.withEvidence) return filtered;

        const summary = yield* queryHookSummary({ tail: 1000 });
        const firedByCommand = new Map<string, { count: number; lastSeen?: Date | string | undefined }>();
        for (const row of summary) {
            const prev = firedByCommand.get(row.command);
            firedByCommand.set(row.command, {
                count: (prev?.count ?? 0) + row.count,
                lastSeen: row.last_seen ?? prev?.lastSeen,
            });
        }
        return filtered.map((h) => {
            const ev = firedByCommand.get(h.command);
            return ev ? { ...h, fired: ev.count, lastSeen: ev.lastSeen } : { ...h, fired: 0 };
        });
    });

/** Select a provider by name, mapping the spine error to the domain error. */
const selectProvider = (
    name: string,
): Effect.Effect<HookProvider, HookProviderNotFoundError, HookProviderRegistry> =>
    Effect.gen(function* () {
        const registry = yield* HookProviderRegistry;
        return yield* registry.select(name).pipe(
            Effect.catchTag("AdapterNotFoundError", (e: AdapterNotFoundError) =>
                new HookProviderNotFoundError({ name: e.name, known: e.known }),
            ),
        );
    });

/** Resolve which config file a provider/scope writes to.
 *  Priority: (1) exact `file` match from a located row; (2) explicit `format`
 *  hint; (3) first ref whose file already EXISTS on disk (so a codex user who
 *  has hooks.json gets writes there instead of config.toml); (4) first ref as
 *  the default (new installations). */
const targetRef = (
    provider: HookProvider,
    scope: HookScope,
    repoRoot: string | null,
    opts: { file?: string | undefined; format?: "json" | "toml" | undefined } = {},
): Effect.Effect<HookFileRef, HookValidationError, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const refs = provider.configFiles(scope, repoRoot);
        if (refs.length === 0) {
            return yield* Effect.fail(new HookValidationError({ provider: provider.name, reason: "no_config_file", detail: `no config file for scope ${scope}` }));
        }

        // (1) exact file match wins unconditionally (routing a codex hook found
        //     in hooks.json back to hooks.json on edit/remove).
        if (opts.file) {
            const found = refs.find((r) => r.path === opts.file);
            if (found) return found;
        }

        // (2) explicit format hint (e.g. --format=toml from the CLI).
        if (opts.format) {
            const found = refs.find((r) => r.format === opts.format);
            if (found) return found;
        }

        // (3) prefer whichever file already exists on disk (codex: hooks.json
        //     wins over config.toml when both are listed and hooks.json is present).
        const fs = yield* FileSystem.FileSystem;
        for (const r of refs) {
            if (yield* fs.exists(r.path).pipe(Effect.orElseSucceed(() => false))) return r;
        }

        // (4) fall back to the first listed ref (new installations default).
        return refs[0]!;
    });

export interface MutateOptions {
    readonly provider: string;
    readonly scope: HookScope;
    readonly repoRoot?: string | null | undefined;
    /** Exact config file to target (from the located row) - routes codex's two files. */
    readonly file?: string | undefined;
    /** for codex: pick the toml or json file when `file` is absent. */
    readonly format?: "json" | "toml" | undefined;
}

/** Add a hook. Returns the resolved file path written. */
export const addHook = (
    opts: MutateOptions & { readonly input: HookInput },
): Effect.Effect<
    string,
    PlatformError | HookConfigParseError | HookConfigSchemaError | HookValidationError | HookProviderNotFoundError,
    HookProviderRegistry | FileSystem.FileSystem | Path.Path
> =>
    Effect.gen(function* () {
        const provider = yield* selectProvider(opts.provider);
        const repoRoot = yield* resolveRepoRoot(opts.repoRoot);
        const ref = yield* targetRef(provider, opts.scope, repoRoot, { file: opts.file, format: opts.format });
        const raw = yield* readMaybe(ref.path);
        const next = yield* provider.applyAdd(ref, raw, opts.input);
        yield* writeFileAtomic(ref.path, next, {
            validate: (text) => provider.parse(ref, text).pipe(Effect.asVoid),
        });
        return ref.path;
    });

const mutateById = (
    opts: MutateOptions & { readonly id: string },
    apply: (provider: HookProvider, ref: HookFileRef, raw: string) => Effect.Effect<string, HookConfigParseError | HookConfigSchemaError | HookValidationError>,
): Effect.Effect<
    string,
    PlatformError | HookConfigParseError | HookConfigSchemaError | HookValidationError | HookProviderNotFoundError | HookNotFoundError,
    HookProviderRegistry | FileSystem.FileSystem | Path.Path
> =>
    Effect.gen(function* () {
        const provider = yield* selectProvider(opts.provider);
        const repoRoot = yield* resolveRepoRoot(opts.repoRoot);
        const ref = yield* targetRef(provider, opts.scope, repoRoot, { file: opts.file, format: opts.format });
        const raw = yield* readMaybe(ref.path);
        // confirm the id exists before mutating, for a clean HookNotFoundError.
        const rows = yield* provider.parse(ref, raw);
        if (!rows.some((r) => r.id === opts.id)) {
            return yield* new HookNotFoundError({ id: opts.id, reason: "missing", candidates: [] });
        }
        const next = yield* apply(provider, ref, raw);
        yield* writeFileAtomic(ref.path, next, {
            validate: (text) => provider.parse(ref, text).pipe(Effect.asVoid),
        });
        return ref.path;
    });

export const removeHook = (
    opts: MutateOptions & { readonly id: string },
) => mutateById(opts, (p, ref, raw) => p.applyRemove(ref, raw, opts.id));

export const editHook = (
    opts: MutateOptions & { readonly id: string; readonly patch: HookPatch },
) => mutateById(opts, (p, ref, raw) => p.applyEdit(ref, raw, opts.id, opts.patch));

/**
 * Disable a hook: move its native entry out of the config file and into a
 * `<file>.ax-parked.json` sidecar. The native config stays authoritative; a
 * parked hook is simply absent from it.
 */
export const disableHook = (
    opts: MutateOptions & { readonly id: string },
): Effect.Effect<
    string,
    PlatformError | HookConfigParseError | HookConfigSchemaError | HookValidationError | HookProviderNotFoundError | HookNotFoundError,
    HookProviderRegistry | FileSystem.FileSystem | Path.Path
> =>
    Effect.gen(function* () {
        const provider = yield* selectProvider(opts.provider);
        const repoRoot = yield* resolveRepoRoot(opts.repoRoot);
        const ref = yield* targetRef(provider, opts.scope, repoRoot, { file: opts.file, format: opts.format });
        const raw = yield* readMaybe(ref.path);
        const rows = yield* provider.parse(ref, raw);
        const hook = rows.find((r) => r.id === opts.id);
        if (!hook) return yield* new HookNotFoundError({ id: opts.id, reason: "missing", candidates: [] });

        const { entry, text } = yield* provider.extractEntry(ref, raw, opts.id);
        const parked = yield* readParked(ref.path);
        if (parked.some((p) => p.hook.id === opts.id)) return ref.path; // already parked, idempotent
        const nextParked = [...parked, { hook, entry }];

        // Save the recoverable artifact (parked) FIRST, then remove from the live
        // config. If the config write fails, roll the parked sidecar back so we
        // never leave a hook saved-but-still-live or lost.
        yield* writeParked(ref.path, nextParked);
        yield* writeFileAtomic(ref.path, text, {
            validate: (t) => provider.parse(ref, t).pipe(Effect.asVoid),
        }).pipe(Effect.tapError(() => writeParked(ref.path, parked).pipe(Effect.ignore)));
        return ref.path;
    });

/**
 * Enable a previously-disabled hook: re-insert its native entry from the park
 * sidecar back into the config file and drop it from the sidecar.
 */
export const enableHook = (
    opts: MutateOptions & { readonly id: string },
): Effect.Effect<
    string,
    PlatformError | HookConfigParseError | HookConfigSchemaError | HookValidationError | HookProviderNotFoundError | HookNotFoundError,
    HookProviderRegistry | FileSystem.FileSystem | Path.Path
> =>
    Effect.gen(function* () {
        const provider = yield* selectProvider(opts.provider);
        const repoRoot = yield* resolveRepoRoot(opts.repoRoot);
        const ref = yield* targetRef(provider, opts.scope, repoRoot, { file: opts.file, format: opts.format });
        const parked = yield* readParked(ref.path);
        const idx = parked.findIndex((p) => p.hook.id === opts.id);
        if (idx < 0) return yield* new HookNotFoundError({ id: opts.id, reason: "missing", candidates: [] });

        const raw = yield* readMaybe(ref.path);
        const next = yield* provider.insertEntry(ref, raw, parked[idx]!.entry);
        const remaining = parked.filter((_, i) => i !== idx);

        // Drop from parked FIRST, then insert into the live config. If the config
        // write fails, restore the parked entry so the hook isn't lost.
        yield* writeParked(ref.path, remaining);
        yield* writeFileAtomic(ref.path, next, {
            validate: (t) => provider.parse(ref, t).pipe(Effect.asVoid),
        }).pipe(Effect.tapError(() => writeParked(ref.path, parked).pipe(Effect.ignore)));
        return ref.path;
    });

/** Padded-column formatter for `ax hooks config`. Computes each column's width
 *  from header + data (mirrors role-format.ts), then fits `command` (last col)
 *  to the remaining terminal width so it never overflows / line-wraps. */
export const formatConfiguredHooks = (rows: ReadonlyArray<ConfiguredHookWithEvidence>): string => {
    type Cell = { id: string; provider: string; scope: string; event: string; matcher: string; owner: string; enabled: string; fired: string; command: string };
    const header: Cell = { id: "id", provider: "provider", scope: "scope", event: "event", matcher: "matcher", owner: "owner", enabled: "enabled", fired: "fired", command: "command" };
    const cells: Cell[] = rows.map((h) => ({
        id: h.id,
        provider: h.provider,
        scope: h.scope,
        event: h.event,
        matcher: h.matcher ?? "",
        owner: h.owner,
        enabled: h.enabled ? "yes" : "no",
        fired: h.fired === undefined ? "" : String(h.fired),
        command: h.command.replace(/\s+/g, " ").trim(),
    }));

    const all = [header, ...cells];
    const w = (k: keyof Cell): number => Math.max(...all.map((c) => c[k].length));
    const fixed = (["id", "provider", "scope", "event", "matcher", "owner", "enabled", "fired"] as const).map(w);
    const gutter = 2;
    const fixedTotal = fixed.reduce((a, b) => a + b + gutter, 0);
    // command gets whatever the terminal has left (min 20), capped at its own data width.
    const term = process.stdout.columns ?? 120;
    const cmdAvail = Math.max(20, term - fixedTotal - 1);
    const cmdW = Math.min(w("command"), cmdAvail);

    const fit = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
    const fmt = (c: Cell): string =>
        c.id.padEnd(fixed[0]!) + "  " +
        c.provider.padEnd(fixed[1]!) + "  " +
        c.scope.padEnd(fixed[2]!) + "  " +
        c.event.padEnd(fixed[3]!) + "  " +
        c.matcher.padEnd(fixed[4]!) + "  " +
        c.owner.padEnd(fixed[5]!) + "  " +
        c.enabled.padEnd(fixed[6]!) + "  " +
        c.fired.padStart(fixed[7]!) + "  " +
        fit(c.command, cmdW);

    return [fmt(header), ...cells.map(fmt)].join("\n");
};
