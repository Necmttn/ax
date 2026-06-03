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
import { deriveHookId, deriveOwner, axMarkerId, genMarkerId, embedMarker, preserveMarker } from "./ownership.ts";

const NAME = "cursor";

const EVENTS = [
    "beforeShellExecution",
    "beforeMCPExecution",
    "beforeReadFile",
    "afterFileEdit",
    "beforeSubmitPrompt",
    "stop",
] as const;

/** Native shape: { version: 1, hooks: { <event>: [ { command } ] } } - NO matcher. */
interface CursorEntry {
    readonly command: string;
    readonly [k: string]: unknown;
}
interface CursorConfig {
    readonly version?: number;
    readonly hooks?: Record<string, CursorEntry[]>;
    readonly [k: string]: unknown;
}

const parseJson = (file: string, raw: string): Effect.Effect<CursorConfig, HookConfigParseError> =>
    Effect.try({
        try: () => (raw.trim() === "" ? {} : (JSON.parse(raw) as CursorConfig)),
        catch: (e) => new HookConfigParseError({ provider: NAME, file, reason: String(e) }),
    });

export const decodeCursor = (ref: HookFileRef, cfg: CursorConfig): ConfiguredHook[] => {
    const out: ConfiguredHook[] = [];
    const hooks = cfg.hooks ?? {};
    for (const event of Object.keys(hooks)) {
        for (const entry of hooks[event] ?? []) {
            const command = entry.command;
            const id = deriveHookId({ provider: NAME, scope: ref.scope, file: ref.path, event, matcher: null, command });
            const ax = axMarkerId(command);
            out.push({
                id, provider: NAME, scope: ref.scope, file: ref.path, event,
                matcher: null, command, enabled: true, owner: deriveOwner(command),
                ...(ax ? { axId: ax } : {}),
            });
        }
    }
    return out;
};

const validateInput = (input: HookInput): Effect.Effect<void, HookValidationError> =>
    Effect.gen(function* () {
        if (!input.command.trim()) return yield* new HookValidationError({ provider: NAME, reason: "empty_command", detail: "command is empty" });
        if (!(EVENTS as readonly string[]).includes(input.event)) return yield* new HookValidationError({ provider: NAME, reason: "unknown_event", detail: `event ${input.event} not in [${EVENTS.join(", ")}]` });
        if (input.matcher != null && input.matcher !== "") return yield* new HookValidationError({ provider: NAME, reason: "matcher_not_supported", detail: "cursor hooks do not support a matcher" });
    });

const serialize = (cfg: CursorConfig): string => {
    const { version: _v, ...rest } = cfg;
    return `${JSON.stringify({ version: cfg.version ?? 1, ...rest }, null, 2)}\n`;
};

const findIndex = (cfg: CursorConfig, ref: HookFileRef, id: string): { event: string; idx: number } | null => {
    const hooks = cfg.hooks ?? {};
    for (const event of Object.keys(hooks)) {
        const arr = hooks[event] ?? [];
        for (let i = 0; i < arr.length; i += 1) {
            const eid = deriveHookId({ provider: NAME, scope: ref.scope, file: ref.path, event, matcher: null, command: arr[i]!.command });
            if (eid === id) return { event, idx: i };
        }
    }
    return null;
};

export const cursorProvider: HookProvider = {
    name: NAME,
    label: "Cursor",
    events: EVENTS,
    matcher: "none",

    configFiles: (scope: HookScope, repoRoot) => {
        if (scope === "global") return [{ path: join(HOME, ".cursor", "hooks.json"), scope, format: "json" }];
        if (scope === "project" && repoRoot) return [{ path: join(repoRoot, ".cursor", "hooks.json"), scope, format: "json" }];
        return [];
    },

    installed: () => existsSync(join(HOME, ".cursor")),

    parse: (ref, raw) =>
        Effect.gen(function* () {
            const cfg = yield* parseJson(ref.path, raw);
            if (cfg.hooks !== undefined && (typeof cfg.hooks !== "object" || Array.isArray(cfg.hooks))) {
                return yield* new HookConfigSchemaError({ provider: NAME, file: ref.path, reason: "`hooks` is not an object" });
            }
            return decodeCursor(ref, cfg);
        }),

    applyAdd: (ref, raw, input) =>
        Effect.gen(function* () {
            yield* validateInput(input);
            const cfg = yield* parseJson(ref.path, raw);
            const id = genMarkerId({ provider: NAME, scope: ref.scope, file: ref.path, event: input.event, matcher: null, command: input.command });
            const command = embedMarker(input.command, id);
            const next: CursorConfig = { version: cfg.version ?? 1, ...cfg, hooks: { ...(cfg.hooks ?? {}) } };
            next.hooks![input.event] = [...(next.hooks![input.event] ?? []), { command }];
            return serialize(next);
        }),

    applyRemove: (ref, raw, id) =>
        Effect.gen(function* () {
            const cfg = yield* parseJson(ref.path, raw);
            const loc = findIndex(cfg, ref, id);
            if (!loc) return raw;
            const next: CursorConfig = { version: cfg.version ?? 1, ...cfg, hooks: { ...(cfg.hooks ?? {}) } };
            const arr = (next.hooks![loc.event] ?? []).filter((_, i) => i !== loc.idx);
            if (arr.length === 0) delete next.hooks![loc.event];
            else next.hooks![loc.event] = arr;
            return serialize(next);
        }),

    applyEdit: (ref, raw, id, patch: HookPatch) =>
        Effect.gen(function* () {
            if (patch.matcher != null && patch.matcher !== "") return yield* new HookValidationError({ provider: NAME, reason: "matcher_not_supported", detail: "cursor hooks do not support a matcher" });
            const cfg = yield* parseJson(ref.path, raw);
            const loc = findIndex(cfg, ref, id);
            if (!loc) return raw;
            const next: CursorConfig = { version: cfg.version ?? 1, ...cfg, hooks: { ...(cfg.hooks ?? {}) } };
            const arr = [...(next.hooks![loc.event] ?? [])];
            arr[loc.idx] = { ...arr[loc.idx]!, ...(patch.command !== undefined ? { command: preserveMarker(arr[loc.idx]!.command, patch.command) } : {}) };
            next.hooks![loc.event] = arr;
            return serialize(next);
        }),

    extractEntry: (ref, raw, id) =>
        Effect.gen(function* () {
            const cfg = yield* parseJson(ref.path, raw);
            const loc = findIndex(cfg, ref, id);
            if (!loc) return { entry: null, text: raw };
            const entry = { event: loc.event, hook: (cfg.hooks ?? {})[loc.event]![loc.idx] };
            const text = yield* cursorProvider.applyRemove(ref, raw, id);
            return { entry, text };
        }),

    insertEntry: (ref, raw, entry) =>
        Effect.gen(function* () {
            const e = entry as { event: string; hook: CursorEntry };
            const cfg = yield* parseJson(ref.path, raw);
            const next: CursorConfig = { version: cfg.version ?? 1, ...cfg, hooks: { ...(cfg.hooks ?? {}) } };
            next.hooks![e.event] = [...(next.hooks![e.event] ?? []), e.hook];
            return serialize(next);
        }),
};
