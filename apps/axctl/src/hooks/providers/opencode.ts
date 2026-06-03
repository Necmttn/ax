import { Effect } from "effect";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { HOME } from "@ax/lib/paths";
import {
    HookConfigParseError,
    HookConfigSchemaError,
    HookValidationError,
} from "../errors.ts";
import type {
    ConfiguredHook,
    HookFileRef,
    HookInput,
    HookPatch,
    HookProvider,
    HookScope,
} from "./types.ts";
import { deriveHookId, deriveOwner, axMarkerId, genMarkerId, embedMarker } from "./ownership.ts";

const NAME = "opencode";

/**
 * opencode events under experimental.hook:
 *   - file_edited: { "<glob>": [ { command: string[], environment? } ] }   (matcher = glob)
 *   - session_completed: [ { command: string[] } ]                          (no matcher)
 */
const EVENTS = ["file_edited", "session_completed"] as const;
const GLOB_EVENTS = new Set<string>(["file_edited"]);

interface OcEntry {
    command: string[];
    environment?: Record<string, string>;
    [k: string]: unknown;
}
interface OcConfig {
    experimental?: {
        hook?: {
            file_edited?: Record<string, OcEntry[]>;
            session_completed?: OcEntry[];
            [k: string]: unknown;
        };
        [k: string]: unknown;
    };
    [k: string]: unknown;
}

const parseJson = (file: string, raw: string): Effect.Effect<OcConfig, HookConfigParseError> =>
    Effect.try({
        try: () => (raw.trim() === "" ? {} : (JSON.parse(raw) as OcConfig)),
        catch: (e) => new HookConfigParseError({ provider: NAME, file, reason: String(e) }),
    });

/** argv → display string. Recognizes the `["sh","-c", cmd]` wrap and unwraps it. */
export const joinArgv = (argv: ReadonlyArray<string>): string => {
    if (argv.length === 3 && argv[0] === "sh" && argv[1] === "-c") return argv[2]!;
    return argv.join(" ");
};

/** display string → argv. Always wraps as `sh -c <cmd>` so shell syntax survives. */
export const wrapArgv = (command: string): string[] => ["sh", "-c", command];

export const decodeOpencode = (ref: HookFileRef, cfg: OcConfig): ConfiguredHook[] => {
    const out: ConfiguredHook[] = [];
    const hook = cfg.experimental?.hook ?? {};
    const fe = hook.file_edited ?? {};
    for (const glob of Object.keys(fe)) {
        for (const entry of fe[glob] ?? []) {
            const argv = entry.command ?? [];
            const command = joinArgv(argv);
            const id = deriveHookId({ provider: NAME, scope: ref.scope, file: ref.path, event: "file_edited", matcher: glob, command });
            const ax = axMarkerId(command);
            out.push({
                id, provider: NAME, scope: ref.scope, file: ref.path, event: "file_edited",
                matcher: glob, command, argv, enabled: true, owner: deriveOwner(command),
                ...(ax ? { axId: ax } : {}),
            });
        }
    }
    for (const entry of hook.session_completed ?? []) {
        const argv = entry.command ?? [];
        const command = joinArgv(argv);
        const id = deriveHookId({ provider: NAME, scope: ref.scope, file: ref.path, event: "session_completed", matcher: null, command });
        const ax = axMarkerId(command);
        out.push({
            id, provider: NAME, scope: ref.scope, file: ref.path, event: "session_completed",
            matcher: null, command, argv, enabled: true, owner: deriveOwner(command),
            ...(ax ? { axId: ax } : {}),
        });
    }
    return out;
};

const validateInput = (input: HookInput): Effect.Effect<void, HookValidationError> =>
    Effect.gen(function* () {
        if (!input.command.trim()) return yield* new HookValidationError({ provider: NAME, reason: "empty_command", detail: "command is empty" });
        if (!(EVENTS as readonly string[]).includes(input.event)) return yield* new HookValidationError({ provider: NAME, reason: "unknown_event", detail: `event ${input.event} not in [${EVENTS.join(", ")}]` });
        if (GLOB_EVENTS.has(input.event) && !(input.matcher && input.matcher.trim())) {
            return yield* new HookValidationError({ provider: NAME, reason: "missing_matcher", detail: `event ${input.event} requires a glob matcher` });
        }
        if (!GLOB_EVENTS.has(input.event) && input.matcher != null && input.matcher !== "") {
            return yield* new HookValidationError({ provider: NAME, reason: "matcher_not_supported", detail: `event ${input.event} does not take a matcher` });
        }
    });

const serialize = (cfg: OcConfig): string => `${JSON.stringify(cfg, null, 2)}\n`;

const cloneHook = (cfg: OcConfig): OcConfig => ({
    ...cfg,
    experimental: {
        ...(cfg.experimental ?? {}),
        hook: {
            ...(cfg.experimental?.hook ?? {}),
            file_edited: { ...(cfg.experimental?.hook?.file_edited ?? {}) },
            session_completed: [...(cfg.experimental?.hook?.session_completed ?? [])],
        },
    },
});

type Loc =
    | { kind: "file_edited"; glob: string; idx: number }
    | { kind: "session_completed"; idx: number };

const find = (cfg: OcConfig, ref: HookFileRef, id: string): Loc | null => {
    const hook = cfg.experimental?.hook ?? {};
    const fe = hook.file_edited ?? {};
    for (const glob of Object.keys(fe)) {
        const arr = fe[glob] ?? [];
        for (let i = 0; i < arr.length; i += 1) {
            const eid = deriveHookId({ provider: NAME, scope: ref.scope, file: ref.path, event: "file_edited", matcher: glob, command: joinArgv(arr[i]!.command ?? []) });
            if (eid === id) return { kind: "file_edited", glob, idx: i };
        }
    }
    const sc = hook.session_completed ?? [];
    for (let i = 0; i < sc.length; i += 1) {
        const eid = deriveHookId({ provider: NAME, scope: ref.scope, file: ref.path, event: "session_completed", matcher: null, command: joinArgv(sc[i]!.command ?? []) });
        if (eid === id) return { kind: "session_completed", idx: i };
    }
    return null;
};

export const opencodeProvider: HookProvider = {
    name: NAME,
    label: "opencode",
    events: EVENTS,
    matcher: "glob",

    configFiles: (scope: HookScope, repoRoot) => {
        if (scope === "global") return [{ path: join(HOME, ".config", "opencode", "opencode.json"), scope, format: "json" }];
        if (scope === "project" && repoRoot) return [{ path: join(repoRoot, "opencode.json"), scope, format: "json" }];
        return [];
    },

    installed: () => existsSync(join(HOME, ".config", "opencode")),

    parse: (ref, raw) =>
        Effect.gen(function* () {
            const cfg = yield* parseJson(ref.path, raw);
            const hook = cfg.experimental?.hook;
            if (hook !== undefined && (typeof hook !== "object" || Array.isArray(hook))) {
                return yield* new HookConfigSchemaError({ provider: NAME, file: ref.path, reason: "`experimental.hook` is not an object" });
            }
            return decodeOpencode(ref, cfg);
        }),

    applyAdd: (ref, raw, input) =>
        Effect.gen(function* () {
            yield* validateInput(input);
            const cfg = yield* parseJson(ref.path, raw);
            const id = genMarkerId({ provider: NAME, scope: ref.scope, file: ref.path, event: input.event, matcher: input.matcher ?? null, command: input.command });
            const command = embedMarker(input.command, id);
            const argv = wrapArgv(command);
            const next = cloneHook(cfg);
            if (input.event === "file_edited") {
                const glob = input.matcher!;
                const fe = next.experimental!.hook!.file_edited!;
                fe[glob] = [...(fe[glob] ?? []), { command: argv }];
            } else {
                next.experimental!.hook!.session_completed = [...(next.experimental!.hook!.session_completed ?? []), { command: argv }];
            }
            return serialize(next);
        }),

    applyRemove: (ref, raw, id) =>
        Effect.gen(function* () {
            const cfg = yield* parseJson(ref.path, raw);
            const loc = find(cfg, ref, id);
            if (!loc) return raw;
            const next = cloneHook(cfg);
            if (loc.kind === "file_edited") {
                const fe = next.experimental!.hook!.file_edited!;
                const arr = (fe[loc.glob] ?? []).filter((_, i) => i !== loc.idx);
                if (arr.length === 0) delete fe[loc.glob];
                else fe[loc.glob] = arr;
            } else {
                next.experimental!.hook!.session_completed = next.experimental!.hook!.session_completed!.filter((_, i) => i !== loc.idx);
            }
            return serialize(next);
        }),

    applyEdit: (ref, raw, id, patch: HookPatch) =>
        Effect.gen(function* () {
            const cfg = yield* parseJson(ref.path, raw);
            const loc = find(cfg, ref, id);
            if (!loc) return raw;
            const next = cloneHook(cfg);
            const applyPatch = (entry: OcEntry): OcEntry =>
                patch.command !== undefined ? { ...entry, command: wrapArgv(patch.command) } : entry;
            if (loc.kind === "file_edited") {
                const fe = next.experimental!.hook!.file_edited!;
                const arr = [...(fe[loc.glob] ?? [])];
                arr[loc.idx] = applyPatch(arr[loc.idx]!);
                // a matcher patch on file_edited re-keys the glob bucket.
                if (patch.matcher !== undefined && patch.matcher !== null && patch.matcher !== loc.glob) {
                    const [moved] = arr.splice(loc.idx, 1);
                    if (arr.length === 0) delete fe[loc.glob];
                    else fe[loc.glob] = arr;
                    fe[patch.matcher] = [...(fe[patch.matcher] ?? []), moved!];
                } else {
                    fe[loc.glob] = arr;
                }
            } else {
                const arr = [...(next.experimental!.hook!.session_completed ?? [])];
                arr[loc.idx] = applyPatch(arr[loc.idx]!);
                next.experimental!.hook!.session_completed = arr;
            }
            return serialize(next);
        }),

    extractEntry: (ref, raw, id) =>
        Effect.gen(function* () {
            const cfg = yield* parseJson(ref.path, raw);
            const loc = find(cfg, ref, id);
            if (!loc) return { entry: null, text: raw };
            const hook = cfg.experimental!.hook!;
            const entry = loc.kind === "file_edited"
                ? { kind: "file_edited" as const, glob: loc.glob, hook: hook.file_edited![loc.glob]![loc.idx] }
                : { kind: "session_completed" as const, hook: hook.session_completed![loc.idx] };
            const text = yield* opencodeProvider.applyRemove(ref, raw, id);
            return { entry, text };
        }),

    insertEntry: (ref, raw, entry) =>
        Effect.gen(function* () {
            const e = entry as
                | { kind: "file_edited"; glob: string; hook: OcEntry }
                | { kind: "session_completed"; hook: OcEntry };
            const cfg = yield* parseJson(ref.path, raw);
            const next = cloneHook(cfg);
            if (e.kind === "file_edited") {
                const fe = next.experimental!.hook!.file_edited!;
                fe[e.glob] = [...(fe[e.glob] ?? []), e.hook];
            } else {
                next.experimental!.hook!.session_completed = [...(next.experimental!.hook!.session_completed ?? []), e.hook];
            }
            return serialize(next);
        }),
};
