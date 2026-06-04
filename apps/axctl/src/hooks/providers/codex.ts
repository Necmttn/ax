import { Effect, FileSystem } from "effect";
import { posixPath } from "@ax/lib/shared/path";
import { orAbsent } from "@ax/lib/shared/fs-error";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
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
import { makeJsonCodec } from "./json-codec.ts";

const NAME = "codex";

/** Codex mirrors Claude's event vocabulary. */
const EVENTS = [
    "PreToolUse",
    "PostToolUse",
    "SessionStart",
    "UserPromptSubmit",
    "Stop",
    "PreCompact",
    "SubagentStop",
    "PermissionRequest",
] as const;

// Codex `hooks.json` is byte-identical to Claude's schema; reuse the shared codec
// with CODEX identity so ids match across read + mutate (no claude delegation).
const jsonCodec = makeJsonCodec(NAME, EVENTS);

/**
 * TOML shape:
 *   [[hooks.PreToolUse]]
 *   matcher = "Bash"
 *   command = "..."        (or [command] nested table { command = "...", timeout = N })
 * JSON shape: identical to claude (hooks.<Event>[].hooks[]).
 */
interface CodexTomlEntry {
    matcher?: string;
    command?: string | { command?: string; timeout?: number };
    timeout?: number;
}
interface CodexToml {
    hooks?: Record<string, CodexTomlEntry[]>;
    [k: string]: unknown;
}

const tomlEntryCommand = (e: CodexTomlEntry): string =>
    typeof e.command === "string" ? e.command : (e.command?.command ?? "");
const tomlEntryTimeout = (e: CodexTomlEntry): number | undefined =>
    typeof e.command === "object" ? e.command?.timeout : e.timeout;

const parseTomlDoc = (file: string, raw: string): Effect.Effect<CodexToml, HookConfigParseError> =>
    Effect.try({
        try: () => (raw.trim() === "" ? {} : (parseToml(raw) as CodexToml)),
        catch: (e) => new HookConfigParseError({ provider: NAME, file, reason: String(e) }),
    });

const decodeTomlDoc = (ref: HookFileRef, doc: CodexToml): ConfiguredHook[] => {
    const out: ConfiguredHook[] = [];
    const hooks = doc.hooks ?? {};
    for (const event of Object.keys(hooks)) {
        const entries = hooks[event];
        // Codex config.toml may hold non-array values under `hooks` (e.g. a
        // bare `notify`/scalar or a single table); only `[[hooks.<Event>]]`
        // array-of-tables entries are lifecycle hooks we decode.
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
            const command = tomlEntryCommand(entry);
            if (!command) continue;
            const matcher = entry.matcher ?? null;
            const id = deriveHookId({ provider: NAME, scope: ref.scope, file: ref.path, event, matcher, command });
            const ax = axMarkerId(command);
            const timeout = tomlEntryTimeout(entry);
            out.push({
                id, provider: NAME, scope: ref.scope, file: ref.path, event, matcher, command,
                ...(timeout !== undefined ? { timeout } : {}), enabled: true, owner: deriveOwner(command),
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
    });

const serializeToml = (doc: CodexToml): string => stringifyToml(doc as Record<string, unknown>);

const findToml = (doc: CodexToml, ref: HookFileRef, id: string): { event: string; idx: number } | null => {
    const hooks = doc.hooks ?? {};
    for (const event of Object.keys(hooks)) {
        const arr = hooks[event];
        if (!Array.isArray(arr)) continue;
        for (let i = 0; i < arr.length; i += 1) {
            const command = tomlEntryCommand(arr[i]!);
            const matcher = arr[i]!.matcher ?? null;
            const eid = deriveHookId({ provider: NAME, scope: ref.scope, file: ref.path, event, matcher, command });
            if (eid === id) return { event, idx: i };
        }
    }
    return null;
};

export const codexProvider: HookProvider = {
    name: NAME,
    label: "Codex",
    events: EVENTS,
    matcher: "tool",

    configFiles: (scope: HookScope, repoRoot) => {
        if (scope === "global") {
            return [
                { path: posixPath.join(HOME, ".codex", "config.toml"), scope, format: "toml" },
                { path: posixPath.join(HOME, ".codex", "hooks.json"), scope, format: "json" },
            ];
        }
        if (scope === "project" && repoRoot) {
            return [{ path: posixPath.join(repoRoot, ".codex", "hooks.json"), scope, format: "json" }];
        }
        return [];
    },

    installed: () =>
        Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            return yield* fs.exists(posixPath.join(HOME, ".codex")).pipe(orAbsent(false));
        }),

    parse: (ref, raw) =>
        ref.format === "toml"
            ? Effect.gen(function* () {
                const doc = yield* parseTomlDoc(ref.path, raw);
                if (doc.hooks !== undefined && (typeof doc.hooks !== "object" || Array.isArray(doc.hooks))) {
                    return yield* new HookConfigSchemaError({ provider: NAME, file: ref.path, reason: "`hooks` is not a table" });
                }
                return decodeTomlDoc(ref, doc);
            })
            : jsonCodec.parse(ref, raw),

    applyAdd: (ref, raw, input) =>
        ref.format === "toml"
            ? Effect.gen(function* () {
                yield* validateInput(input);
                const doc = yield* parseTomlDoc(ref.path, raw);
                const matcher = input.matcher ?? null;
                const id = genMarkerId({ provider: NAME, scope: ref.scope, file: ref.path, event: input.event, matcher, command: input.command });
                const command = embedMarker(input.command, id);
                const next: CodexToml = { ...doc, hooks: { ...(doc.hooks ?? {}) } };
                const entry: CodexTomlEntry = {
                    ...(matcher !== null ? { matcher } : {}),
                    command,
                    ...(input.timeout !== undefined ? { timeout: input.timeout } : {}),
                };
                next.hooks![input.event] = [...(next.hooks![input.event] ?? []), entry];
                return serializeToml(next);
            })
            : jsonCodec.applyAdd(ref, raw, input),

    applyRemove: (ref, raw, id) =>
        ref.format === "toml"
            ? Effect.gen(function* () {
                const doc = yield* parseTomlDoc(ref.path, raw);
                const loc = findToml(doc, ref, id);
                if (!loc) return raw;
                const next: CodexToml = { ...doc, hooks: { ...(doc.hooks ?? {}) } };
                const arr = (next.hooks![loc.event] ?? []).filter((_, i) => i !== loc.idx);
                if (arr.length === 0) delete next.hooks![loc.event];
                else next.hooks![loc.event] = arr;
                return serializeToml(next);
            })
            : jsonCodec.applyRemove(ref, raw, id),

    applyEdit: (ref, raw, id, patch: HookPatch) =>
        ref.format === "toml"
            ? Effect.gen(function* () {
                const doc = yield* parseTomlDoc(ref.path, raw);
                const loc = findToml(doc, ref, id);
                if (!loc) return raw;
                const next: CodexToml = { ...doc, hooks: { ...(doc.hooks ?? {}) } };
                const arr = [...(next.hooks![loc.event] ?? [])];
                const cur = { ...arr[loc.idx]! };
                if (patch.command !== undefined) {
                    const oldCmd = (typeof cur.command === "object" && cur.command ? cur.command.command : (cur.command as string | undefined)) ?? "";
                    const nextCmd = preserveMarker(oldCmd, patch.command);
                    if (typeof cur.command === "object" && cur.command) cur.command = { ...cur.command, command: nextCmd };
                    else cur.command = nextCmd;
                }
                if (patch.timeout !== undefined) {
                    if (typeof cur.command === "object" && cur.command) cur.command = { ...cur.command, timeout: patch.timeout };
                    else cur.timeout = patch.timeout;
                }
                if (patch.matcher !== undefined) {
                    if (patch.matcher === null) delete cur.matcher;
                    else cur.matcher = patch.matcher;
                }
                arr[loc.idx] = cur;
                next.hooks![loc.event] = arr;
                return serializeToml(next);
            })
            : jsonCodec.applyEdit(ref, raw, id, patch),

    extractEntry: (ref, raw, id) =>
        ref.format === "toml"
            ? Effect.gen(function* () {
                const doc = yield* parseTomlDoc(ref.path, raw);
                const loc = findToml(doc, ref, id);
                if (!loc) return { entry: null, text: raw };
                const entry = { event: loc.event, toml: (doc.hooks ?? {})[loc.event]![loc.idx] };
                const text = yield* codexProvider.applyRemove(ref, raw, id);
                return { entry, text };
            })
            : jsonCodec.extractEntry(ref, raw, id),

    insertEntry: (ref, raw, entry) =>
        ref.format === "toml"
            ? Effect.gen(function* () {
                const e = entry as { event: string; toml: CodexTomlEntry };
                const doc = yield* parseTomlDoc(ref.path, raw);
                const next: CodexToml = { ...doc, hooks: { ...(doc.hooks ?? {}) } };
                next.hooks![e.event] = [...(next.hooks![e.event] ?? []), e.toml];
                return serializeToml(next);
            })
            : jsonCodec.insertEntry(ref, raw, entry),
};
