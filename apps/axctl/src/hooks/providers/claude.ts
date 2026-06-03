import { Effect } from "effect";
import { join } from "node:path";
import { HOME } from "@ax/lib/paths";
import { existsSync } from "node:fs";
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

const NAME = "claude";

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

/** Native shape: { hooks: { <Event>: [ { matcher?, hooks: [ {type,command,timeout?} ] } ] } } */
interface ClaudeCommandEntry {
    readonly type: "command";
    readonly command: string;
    readonly timeout?: number;
}
interface ClaudeMatcherGroup {
    readonly matcher?: string;
    readonly hooks: ClaudeCommandEntry[];
}
interface ClaudeSettings {
    readonly hooks?: Record<string, ClaudeMatcherGroup[]>;
    readonly [k: string]: unknown;
}

const parseJson = (
    file: string,
    raw: string,
): Effect.Effect<ClaudeSettings, HookConfigParseError> =>
    Effect.try({
        try: () => (raw.trim() === "" ? {} : (JSON.parse(raw) as ClaudeSettings)),
        catch: (e) =>
            new HookConfigParseError({ provider: NAME, file, reason: String(e) }),
    });

/** Flatten the nested groups into normalized ConfiguredHook rows. */
export const decodeClaude = (
    ref: HookFileRef,
    settings: ClaudeSettings,
): ConfiguredHook[] => {
    const out: ConfiguredHook[] = [];
    const hooks = settings.hooks ?? {};
    for (const event of Object.keys(hooks)) {
        for (const group of hooks[event] ?? []) {
            const matcher = group.matcher ?? null;
            for (const entry of group.hooks ?? []) {
                const command = entry.command;
                const id = deriveHookId({ provider: NAME, scope: ref.scope, file: ref.path, event, matcher, command });
                const ax = axMarkerId(command);
                out.push({
                    id,
                    provider: NAME,
                    scope: ref.scope,
                    file: ref.path,
                    event,
                    matcher,
                    command,
                    ...(entry.timeout !== undefined ? { timeout: entry.timeout } : {}),
                    enabled: true,
                    owner: deriveOwner(command),
                    ...(ax ? { axId: ax } : {}),
                });
            }
        }
    }
    return out;
};

const validateInput = (
    input: HookInput,
): Effect.Effect<void, HookValidationError> =>
    Effect.gen(function* () {
        if (!input.command.trim()) {
            return yield* new HookValidationError({ provider: NAME, reason: "empty_command", detail: "command is empty" });
        }
        if (!(EVENTS as readonly string[]).includes(input.event)) {
            return yield* new HookValidationError({ provider: NAME, reason: "unknown_event", detail: `event ${input.event} not in [${EVENTS.join(", ")}]` });
        }
    });

const serialize = (settings: ClaudeSettings): string => `${JSON.stringify(settings, null, 2)}\n`;

const findEntry = (
    settings: ClaudeSettings,
    ref: HookFileRef,
    id: string,
): { event: string; gi: number; hi: number; group: ClaudeMatcherGroup } | null => {
    const hooks = settings.hooks ?? {};
    for (const event of Object.keys(hooks)) {
        const groups = hooks[event] ?? [];
        for (let gi = 0; gi < groups.length; gi += 1) {
            const group = groups[gi]!;
            for (let hi = 0; hi < (group.hooks ?? []).length; hi += 1) {
                const command = group.hooks[hi]!.command;
                const matcher = group.matcher ?? null;
                const eid = deriveHookId({ provider: NAME, scope: ref.scope, file: ref.path, event, matcher, command });
                if (eid === id) return { event, gi, hi, group };
            }
        }
    }
    return null;
};

export const claudeProvider: HookProvider = {
    name: NAME,
    label: "Claude Code",
    events: EVENTS,
    matcher: "tool",

    configFiles: (scope: HookScope, repoRoot) => {
        if (scope === "global") return [{ path: join(HOME, ".claude", "settings.json"), scope, format: "json" }];
        if (!repoRoot) return [];
        if (scope === "project") return [{ path: join(repoRoot, ".claude", "settings.json"), scope, format: "json" }];
        return [{ path: join(repoRoot, ".claude", "settings.local.json"), scope, format: "json" }];
    },

    installed: () => existsSync(join(HOME, ".claude")),

    parse: (ref, raw) =>
        Effect.gen(function* () {
            const settings = yield* parseJson(ref.path, raw);
            if (settings.hooks !== undefined && (typeof settings.hooks !== "object" || Array.isArray(settings.hooks))) {
                return yield* new HookConfigSchemaError({ provider: NAME, file: ref.path, reason: "`hooks` is not an object" });
            }
            return decodeClaude(ref, settings);
        }),

    applyAdd: (ref, raw, input) =>
        Effect.gen(function* () {
            yield* validateInput(input);
            const settings = yield* parseJson(ref.path, raw);
            const matcher = input.matcher ?? undefined;
            const id = genMarkerId({ provider: NAME, scope: ref.scope, file: ref.path, event: input.event, matcher: input.matcher ?? null, command: input.command });
            const command = embedMarker(input.command, id);
            const entry: ClaudeCommandEntry = { type: "command", command, ...(input.timeout !== undefined ? { timeout: input.timeout } : {}) };
            const next: ClaudeSettings = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
            const groups = [...(next.hooks![input.event] ?? [])];
            // merge into an existing group with the same matcher, else append.
            const gi = groups.findIndex((g) => (g.matcher ?? undefined) === matcher);
            if (gi >= 0) groups[gi] = { ...groups[gi]!, hooks: [...groups[gi]!.hooks, entry] };
            else groups.push({ ...(matcher !== undefined ? { matcher } : {}), hooks: [entry] });
            next.hooks![input.event] = groups;
            return serialize(next);
        }),

    applyRemove: (ref, raw, id) =>
        Effect.gen(function* () {
            const settings = yield* parseJson(ref.path, raw);
            const loc = findEntry(settings, ref, id);
            if (!loc) return raw;
            const next: ClaudeSettings = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
            const groups = [...(next.hooks![loc.event] ?? [])];
            const group = groups[loc.gi]!;
            const hooksArr = group.hooks.filter((_, i) => i !== loc.hi);
            if (hooksArr.length === 0) groups.splice(loc.gi, 1);
            else groups[loc.gi] = { ...group, hooks: hooksArr };
            if (groups.length === 0) delete next.hooks![loc.event];
            else next.hooks![loc.event] = groups;
            return serialize(next);
        }),

    applyEdit: (ref, raw, id, patch: HookPatch) =>
        Effect.gen(function* () {
            const settings = yield* parseJson(ref.path, raw);
            const loc = findEntry(settings, ref, id);
            if (!loc) return raw;
            const next: ClaudeSettings = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
            const groups = [...(next.hooks![loc.event] ?? [])];
            const group = { ...groups[loc.gi]! };
            const hooksArr = [...group.hooks];
            const cur = hooksArr[loc.hi]!;
            hooksArr[loc.hi] = {
                ...cur,
                ...(patch.command !== undefined ? { command: preserveMarker(cur.command, patch.command) } : {}),
                ...(patch.timeout !== undefined ? { timeout: patch.timeout } : {}),
            };
            group.hooks = hooksArr;
            if (patch.matcher !== undefined) {
                if (patch.matcher === null) delete (group as { matcher?: string }).matcher;
                else (group as { matcher?: string }).matcher = patch.matcher;
            }
            groups[loc.gi] = group;
            next.hooks![loc.event] = groups;
            return serialize(next);
        }),

    extractEntry: (ref, raw, id) =>
        Effect.gen(function* () {
            const settings = yield* parseJson(ref.path, raw);
            const loc = findEntry(settings, ref, id);
            if (!loc) return { entry: null, text: raw };
            const group = loc.group;
            const entry = { event: loc.event, matcher: group.matcher ?? null, hook: group.hooks[loc.hi] };
            const text = yield* claudeProvider.applyRemove(ref, raw, id);
            return { entry, text };
        }),

    insertEntry: (ref, raw, entry) =>
        Effect.gen(function* () {
            const e = entry as { event: string; matcher: string | null; hook: ClaudeCommandEntry };
            const settings = yield* parseJson(ref.path, raw);
            const next: ClaudeSettings = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
            const groups = [...(next.hooks![e.event] ?? [])];
            const matcher = e.matcher ?? undefined;
            const gi = groups.findIndex((g) => (g.matcher ?? undefined) === matcher);
            if (gi >= 0) groups[gi] = { ...groups[gi]!, hooks: [...groups[gi]!.hooks, e.hook] };
            else groups.push({ ...(matcher !== undefined ? { matcher } : {}), hooks: [e.hook] });
            next.hooks![e.event] = groups;
            return serialize(next);
        }),
};
