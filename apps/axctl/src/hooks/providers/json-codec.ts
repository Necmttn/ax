import { Effect } from "effect";
import { decodeJsonOrNull } from "@ax/lib/decode";
import { HookConfigParseError, HookConfigSchemaError, HookValidationError } from "../errors.ts";
import type { ConfiguredHook, HookFileRef, HookInput, HookPatch } from "./types.ts";
import { deriveHookId, deriveOwner, axMarkerId, genMarkerId, embedMarker, preserveMarker } from "./ownership.ts";

/**
 * Claude Code's `settings.json` hook schema, shared verbatim by Codex's
 * `hooks.json`. Both flatten `hooks.{Event}[].{matcher,hooks[]}` into normalized
 * rows; the ONLY difference is the provider identity stamped on each row's
 * `provider`/`id`. Parameterizing by `name` (instead of Codex delegating to the
 * claude codec) keeps ids consistent across read and mutate - a Codex `hooks.json`
 * entry is hashed with provider `codex` everywhere, so `remove`/`edit` actually
 * find it.
 */

export interface ClaudeCommandEntry {
    readonly type: "command";
    readonly command: string;
    readonly timeout?: number;
}
export interface ClaudeMatcherGroup {
    readonly matcher?: string;
    readonly hooks: ClaudeCommandEntry[];
}
export interface ClaudeSettings {
    readonly hooks?: Record<string, ClaudeMatcherGroup[]>;
    readonly [k: string]: unknown;
}

export interface JsonCodec {
    readonly parse: (ref: HookFileRef, raw: string) => Effect.Effect<ConfiguredHook[], HookConfigParseError | HookConfigSchemaError>;
    readonly applyAdd: (ref: HookFileRef, raw: string, input: HookInput) => Effect.Effect<string, HookConfigParseError | HookValidationError>;
    readonly applyRemove: (ref: HookFileRef, raw: string, id: string) => Effect.Effect<string, HookConfigParseError>;
    readonly applyEdit: (ref: HookFileRef, raw: string, id: string, patch: HookPatch) => Effect.Effect<string, HookConfigParseError>;
    readonly extractEntry: (ref: HookFileRef, raw: string, id: string) => Effect.Effect<{ entry: unknown; text: string }, HookConfigParseError>;
    readonly insertEntry: (ref: HookFileRef, raw: string, entry: unknown) => Effect.Effect<string, HookConfigParseError>;
}

export const makeJsonCodec = (name: string, events: readonly string[]): JsonCodec => {
    const parseJson = (file: string, raw: string): Effect.Effect<ClaudeSettings, HookConfigParseError> => {
        if (raw.trim() === "") return Effect.succeed({});
        const parsed = decodeJsonOrNull(raw);
        return parsed === null
            ? Effect.fail(new HookConfigParseError({ provider: name, file, reason: "invalid JSON" }))
            : Effect.succeed(parsed as ClaudeSettings);
    };

    const serialize = (settings: ClaudeSettings): string => `${JSON.stringify(settings, null, 2)}\n`;

    const decode = (ref: HookFileRef, settings: ClaudeSettings): ConfiguredHook[] => {
        const out: ConfiguredHook[] = [];
        const hooks = settings.hooks ?? {};
        for (const event of Object.keys(hooks)) {
            for (const group of hooks[event] ?? []) {
                const matcher = group.matcher ?? null;
                for (const entry of group.hooks ?? []) {
                    const command = entry.command;
                    const id = deriveHookId({ provider: name, scope: ref.scope, file: ref.path, event, matcher, command });
                    const ax = axMarkerId(command);
                    out.push({
                        id, provider: name, scope: ref.scope, file: ref.path, event, matcher, command,
                        ...(entry.timeout !== undefined ? { timeout: entry.timeout } : {}),
                        enabled: true, owner: deriveOwner(command),
                        ...(ax ? { axId: ax } : {}),
                    });
                }
            }
        }
        return out;
    };

    const validateInput = (input: HookInput): Effect.Effect<void, HookValidationError> =>
        Effect.gen(function* () {
            if (!input.command.trim()) return yield* new HookValidationError({ provider: name, reason: "empty_command", detail: "command is empty" });
            if (!events.includes(input.event)) return yield* new HookValidationError({ provider: name, reason: "unknown_event", detail: `event ${input.event} not in [${events.join(", ")}]` });
        });

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
                    const eid = deriveHookId({ provider: name, scope: ref.scope, file: ref.path, event, matcher, command });
                    if (eid === id) return { event, gi, hi, group };
                }
            }
        }
        return null;
    };

    const applyRemove = (ref: HookFileRef, raw: string, id: string) =>
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
        });

    return {
        parse: (ref, raw) =>
            Effect.gen(function* () {
                const settings = yield* parseJson(ref.path, raw);
                if (settings.hooks !== undefined && (typeof settings.hooks !== "object" || Array.isArray(settings.hooks))) {
                    return yield* new HookConfigSchemaError({ provider: name, file: ref.path, reason: "`hooks` is not an object" });
                }
                return decode(ref, settings);
            }),

        applyAdd: (ref, raw, input) =>
            Effect.gen(function* () {
                yield* validateInput(input);
                const settings = yield* parseJson(ref.path, raw);
                const matcher = input.matcher ?? undefined;
                const id = genMarkerId({ provider: name, scope: ref.scope, file: ref.path, event: input.event, matcher: input.matcher ?? null, command: input.command });
                const command = embedMarker(input.command, id);
                const entry: ClaudeCommandEntry = { type: "command", command, ...(input.timeout !== undefined ? { timeout: input.timeout } : {}) };
                const next: ClaudeSettings = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
                const groups = [...(next.hooks![input.event] ?? [])];
                const gi = groups.findIndex((g) => (g.matcher ?? undefined) === matcher);
                if (gi >= 0) groups[gi] = { ...groups[gi]!, hooks: [...groups[gi]!.hooks, entry] };
                else groups.push({ ...(matcher !== undefined ? { matcher } : {}), hooks: [entry] });
                next.hooks![input.event] = groups;
                return serialize(next);
            }),

        applyRemove,

        applyEdit: (ref, raw, id, patch) =>
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
                const entry = { event: loc.event, matcher: loc.group.matcher ?? null, hook: loc.group.hooks[loc.hi] };
                const text = yield* applyRemove(ref, raw, id);
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
};
