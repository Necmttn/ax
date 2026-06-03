import { Context, Layer } from "effect";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { makeRegistry, type AdapterRegistry } from "../../config-core/registry.ts";
import type { AdapterNotFoundError } from "../../config-core/errors.ts";
import { makeDirSource } from "./dir.ts";
import { makeCommandSource } from "./command.ts";
import type { SkillDirRef, SkillSource } from "./types.ts";

const HOME = homedir();

/** Safe synchronous dir listing - missing/unreadable -> []. Roots enumeration
 *  is cheap and the `SkillSource.roots()` contract is synchronous, so plugin /
 *  project fan-out resolves their leaf roots here, not inside `discover`. */
const lsDirs = (dir: string): string[] => {
    try {
        return readdirSync(dir).filter((e) => {
            try {
                return statSync(join(dir, e)).isDirectory();
            } catch {
                return false;
            }
        });
    } catch {
        return [];
    }
};

// --- user (~/.claude/skills) ------------------------------------------------
const claudeUser = makeDirSource({
    name: "user",
    label: "Claude user skills (~/.claude/skills)",
    writable: true,
    roots: () => [{ root: join(HOME, ".claude", "skills"), scope: "user", writable: true }],
});

// --- agents-shared (~/.agents/skills) --------------------------------------
const agentsShared = makeDirSource({
    name: "agents-shared",
    label: "Shared agent skills (~/.agents/skills)",
    writable: true,
    roots: () => [
        { root: join(HOME, ".agents", "skills"), scope: "agents-shared", writable: true },
    ],
});

// --- codex (~/.codex/skills + ~/.codex/skills/.system read-only) -----------
const codex = makeDirSource({
    name: "codex",
    label: "Codex skills (~/.codex/skills)",
    writable: true,
    roots: () => {
        const base = join(HOME, ".codex", "skills");
        const refs: SkillDirRef[] = [{ root: base, scope: "codex", writable: true }];
        const system = join(base, ".system");
        refs.push({ root: system, scope: "codex:.system", writable: false });
        return refs;
    },
});

// --- plugin (~/.claude/plugins/cache/<mkt>/<plugin>/<ver>/skills) ----------
// Read-only: CRUD goes through the plugin manager, not ax.
const plugin = makeDirSource({
    name: "plugin",
    label: "Plugin skills (~/.claude/plugins/cache)",
    writable: false,
    roots: () => {
        const cache = join(HOME, ".claude", "plugins", "cache");
        const refs: SkillDirRef[] = [];
        for (const market of lsDirs(cache)) {
            const marketDir = join(cache, market);
            for (const pluginName of lsDirs(marketDir)) {
                const pluginDir = join(marketDir, pluginName);
                for (const version of lsDirs(pluginDir)) {
                    refs.push({
                        root: join(pluginDir, version, "skills"),
                        scope: `plugin:${pluginName}`,
                        writable: false,
                    });
                }
            }
        }
        return refs;
    },
});

// --- project (<repo>/.claude/skills) ---------------------------------------
const project = makeDirSource({
    name: "project",
    label: "Project skills (<repo>/.claude/skills)",
    writable: true,
    roots: (repoRoot) => {
        if (!repoRoot) return [];
        const name = repoRoot.split("/").filter(Boolean).pop() ?? "project";
        return [
            {
                root: join(repoRoot, ".claude", "skills"),
                scope: `project:${name}`,
                writable: true,
            },
        ];
    },
});

// --- command (~/.claude/commands + <repo>/.claude/commands) ----------------
const command = makeCommandSource({
    label: "Slash commands (~/.claude/commands)",
    writable: true,
    roots: (repoRoot) => {
        const refs: SkillDirRef[] = [
            { root: join(HOME, ".claude", "commands"), scope: "command", writable: true },
        ];
        if (repoRoot) {
            const name = repoRoot.split("/").filter(Boolean).pop() ?? "project";
            refs.push({
                root: join(repoRoot, ".claude", "commands"),
                scope: `project-command:${name}`,
                writable: true,
            });
        }
        return refs;
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
