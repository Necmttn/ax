import { join } from "node:path";
import { posixPath } from "@ax/lib/shared/path";
import { orAbsent } from "@ax/lib/shared/fs-error";
import { Effect, FileSystem } from "effect";
import { HOME } from "@ax/lib/paths";
import type { HookProvider, HookScope } from "./types.ts";
import { makeJsonCodec } from "./json-codec.ts";

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

const codec = makeJsonCodec(NAME, EVENTS);

/** Claude Code: `~/.claude/settings.json` (+ project + local). JSON, tool matcher. */
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

    installed: () =>
        Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            return yield* fs.exists(posixPath.join(HOME, ".claude")).pipe(orAbsent(false));
        }),

    parse: codec.parse,
    applyAdd: codec.applyAdd,
    applyRemove: codec.applyRemove,
    applyEdit: codec.applyEdit,
    extractEntry: codec.extractEntry,
    insertEntry: codec.insertEntry,
};
