import { Context, Effect, FileSystem, Layer, Path } from "effect";
import { homedir } from "node:os";
import { posixPath } from "@ax/lib/shared/path";
import { orAbsent } from "@ax/lib/shared/fs-error";
import { makeRegistry, type AdapterRegistry } from "../../config-core/registry.ts";
import type { AdapterNotFoundError } from "../../config-core/errors.ts";
import { makeDirSource } from "./dir.ts";
import { makeCommandSource } from "./command.ts";
import type { SkillDirRef, SkillSource } from "./types.ts";

const HOME = homedir();

/** Safe dir listing - missing/unreadable -> []; entries that are directories
 *  (symlink-following, matching the original `statSync().isDirectory()`).
 *  `roots()` is fan-out, so plugin / project sources resolve their leaf roots
 *  here, not inside `discover`. */
const lsDirs = (
    dir: string,
): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const entries = yield* fs.readDirectory(dir).pipe(orAbsent<ReadonlyArray<string>>([]));
        const dirs: string[] = [];
        for (const e of entries) {
            // stat (not lstat) follows symlinks, matching the original isDirectory probe.
            const isDir = yield* fs.stat(path.join(dir, e)).pipe(
                Effect.map((info) => info.type === "Directory"),
                orAbsent(false),
            );
            if (isDir) dirs.push(e);
        }
        return dirs;
    });

// --- user (~/.claude/skills) ------------------------------------------------
const claudeUser = makeDirSource({
    name: "user",
    label: "Claude user skills (~/.claude/skills)",
    writable: true,
    roots: () => Effect.succeed([{ root: posixPath.join(HOME, ".claude", "skills"), scope: "user", writable: true }]),
});

// --- agents-shared (~/.agents/skills) --------------------------------------
const agentsShared = makeDirSource({
    name: "agents-shared",
    label: "Shared agent skills (~/.agents/skills)",
    writable: true,
    roots: () => Effect.succeed([
        { root: posixPath.join(HOME, ".agents", "skills"), scope: "agents-shared", writable: true },
    ]),
});

// --- codex (~/.codex/skills + ~/.codex/skills/.system read-only) -----------
const codex = makeDirSource({
    name: "codex",
    label: "Codex skills (~/.codex/skills)",
    writable: true,
    roots: () => {
        const base = posixPath.join(HOME, ".codex", "skills");
        const refs: SkillDirRef[] = [{ root: base, scope: "codex", writable: true }];
        const system = posixPath.join(base, ".system");
        refs.push({ root: system, scope: "codex:.system", writable: false });
        return Effect.succeed(refs);
    },
});

// --- plugin (~/.claude/plugins/cache/<mkt>/<plugin>/<ver>/skills) ----------
// Read-only: CRUD goes through the plugin manager, not ax.
const plugin = makeDirSource({
    name: "plugin",
    label: "Plugin skills (~/.claude/plugins/cache)",
    writable: false,
    roots: () =>
        Effect.gen(function* () {
            const cache = posixPath.join(HOME, ".claude", "plugins", "cache");
            const refs: SkillDirRef[] = [];
            for (const market of yield* lsDirs(cache)) {
                const marketDir = posixPath.join(cache, market);
                for (const pluginName of yield* lsDirs(marketDir)) {
                    const pluginDir = posixPath.join(marketDir, pluginName);
                    for (const version of yield* lsDirs(pluginDir)) {
                        refs.push({
                            root: posixPath.join(pluginDir, version, "skills"),
                            scope: `plugin:${pluginName}`,
                            writable: false,
                        });
                    }
                }
            }
            return refs;
        }),
});

// --- project (<repo>/.claude/skills) ---------------------------------------
const project = makeDirSource({
    name: "project",
    label: "Project skills (<repo>/.claude/skills)",
    writable: true,
    roots: (repoRoot) => {
        if (!repoRoot) return Effect.succeed([]);
        const name = repoRoot.split("/").filter(Boolean).pop() ?? "project";
        return Effect.succeed([
            {
                root: posixPath.join(repoRoot, ".claude", "skills"),
                scope: `project:${name}`,
                writable: true,
            },
        ]);
    },
});

// --- command (~/.claude/commands + <repo>/.claude/commands) ----------------
const command = makeCommandSource({
    label: "Slash commands (~/.claude/commands)",
    writable: true,
    roots: (repoRoot) => {
        const refs: SkillDirRef[] = [
            { root: posixPath.join(HOME, ".claude", "commands"), scope: "command", writable: true },
        ];
        if (repoRoot) {
            const name = repoRoot.split("/").filter(Boolean).pop() ?? "project";
            refs.push({
                root: posixPath.join(repoRoot, ".claude", "commands"),
                scope: `project-command:${name}`,
                writable: true,
            });
        }
        return Effect.succeed(refs);
    },
});

/** The six skill sources, in precedence order (user wins over plugin on dedup). */
export const defaultSkillSources: ReadonlyArray<SkillSource> = [
    claudeUser,
    agentsShared,
    codex,
    plugin,
    project,
    command,
];

export interface SkillSourceRegistryShape extends AdapterRegistry<SkillSource> {}

/**
 * `SkillSourceRegistry` - the skill analogue of `ClassifierRegistry`. `select`
 * fails with `AdapterNotFoundError` (domain `"skill-source"`) rather than
 * handing back `undefined`. Tag-only service (shape supplied by a `Layer`),
 * mirroring `ClassifierRegistry` / `SurrealClient`.
 */
export class SkillSourceRegistry extends Context.Service<
    SkillSourceRegistry,
    SkillSourceRegistryShape
>()("ax/SkillSourceRegistry") {}

/** Default layer over the six built-in sources. */
export const SkillSourceRegistryLive: Layer.Layer<SkillSourceRegistry> =
    Layer.succeed(SkillSourceRegistry, makeRegistry("skill-source", defaultSkillSources));

/** Build a registry layer over an explicit source list (test fixtures). */
export const makeSkillSourceRegistryLayer = (
    sources: ReadonlyArray<SkillSource>,
): Layer.Layer<SkillSourceRegistry> =>
    Layer.succeed(SkillSourceRegistry, makeRegistry("skill-source", sources));

/** Re-export for callers that catch the registry miss by tag. */
export type { AdapterNotFoundError };
