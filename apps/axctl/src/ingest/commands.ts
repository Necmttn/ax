import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { Effect, FileSystem, Path, Schema } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { SkillName } from "@ax/lib/brands";
import { BaseStageStats, IngestContext, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";
import { AppLayer } from "@ax/lib/layers";
import type { DbError } from "@ax/lib/errors";
import { upsertSkillByName } from "./skill-upsert.ts";
import { discoverProjectRoots } from "./project-discovery.ts";
import { orAbsent } from "@ax/lib/shared/fs-error";
import { posixPath } from "@ax/lib/shared/path";

// Slash commands live alongside skills but in `~/.claude/commands/` (and
// per-project `<repo>/.claude/commands/`) and aren't indexed by ingestSkills.
// Without ingesting them, every Skill tool invocation that targets a slash
// command (simplify, review-all, /loop, ...) creates an orphan `invoked` edge
// pointing at a skill row that never existed - which is what was hiding ~5300
// invocations from `axctl taste / unused / stats`. See issues #41 and #42.

interface ParsedCommand {
    name: string;
    description: string | undefined;
    body: string;
    bytes: number;
}

interface CommandItem {
    parsed: ParsedCommand;
    dir_path: string;
    scope: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

function looseLineParse(raw: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const line of raw.split("\n")) {
        const m = line.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/);
        if (!m) continue;
        const [, key, value] = m;
        if (value === "") continue;
        out[key] = value.replace(/^["']|["']$/g, "");
    }
    return out;
}

function firstNonEmptyLine(body: string): string | undefined {
    for (const line of body.split("\n")) {
        const t = line.trim();
        if (t) return t.slice(0, 500);
    }
    return undefined;
}

/**
 * Parse a command markdown file. Frontmatter is optional - when missing,
 * fall back to the first non-empty line of the body as a synthetic
 * description so the command is still searchable.
 */
function parseCommandFile(content: string, name: string): ParsedCommand {
    const m = content.match(FRONTMATTER_RE);
    const bytes = Buffer.byteLength(content, "utf8");
    if (!m) {
        return {
            name,
            description: firstNonEmptyLine(content),
            body: content,
            bytes,
        };
    }
    let fm: Record<string, unknown> = {};
    try {
        fm = (parseYaml(m[1]) ?? {}) as Record<string, unknown>;
    } catch {
        // Same tolerance as skills.ts - some hand-written frontmatter
        // contains unquoted colons in descriptions.
        fm = looseLineParse(m[1]);
    }
    const description =
        typeof fm.description === "string" ? fm.description : firstNonEmptyLine(m[2]);
    return { name, description, body: m[2], bytes };
}

/**
 * Walk a `commands/` directory recursively. Subdirectories form a namespace
 * prefix on the command name (e.g. `commands/gsd/plan-phase.md` → name
 * `gsd:plan-phase`), which matches the canonical slash-command form Claude
 * emits in `Skill` tool invocations.
 */
const walkCommandsDir = (
    root: string,
    namespacePrefix: string,
): Effect.Effect<
    { name: string; full: string }[],
    never,
    FileSystem.FileSystem | Path.Path
> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const out: { name: string; full: string }[] = [];
        // OLD: readdir in try/catch → return []. A missing/unreadable dir is a
        // tolerated discovery miss, so recover ANY PlatformError to [].
        const entries = yield* fs.readDirectory(root).pipe(orAbsent([] as string[]));
        for (const entry of entries) {
            const full = path.join(root, entry);
            // OLD: stat in try/catch → continue on error. Recover the stat to a
            // sentinel `null` (skip) matching the per-entry tolerance.
            const st = yield* fs.stat(full).pipe(orAbsent(null as FileSystem.File.Info | null));
            if (st === null) continue;
            if (st.type === "Directory") {
                const sub = yield* walkCommandsDir(
                    full,
                    namespacePrefix ? `${namespacePrefix}:${entry}` : entry,
                );
                out.push(...sub);
                continue;
            }
            if (st.type !== "File" || !entry.endsWith(".md")) continue;
            const base = entry.slice(0, -3);
            // Skip README/marketplace metadata files - they're not commands.
            if (base.toUpperCase() === "README") continue;
            const name = namespacePrefix ? `${namespacePrefix}:${base}` : base;
            out.push({ name, full });
        }
        return out;
    });

const readCommandsRoot = (
    root: string,
    scope: string,
    namespacePrefix = "",
): Effect.Effect<CommandItem[], never, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const files = yield* walkCommandsDir(root, namespacePrefix);
        const out: CommandItem[] = [];
        for (const f of files) {
            // OLD: readFile in try/catch → continue (skip a file that vanished
            // or is unreadable). orAbsent(null) recovers any read fault to skip.
            const content = yield* fs.readFileString(f.full).pipe(orAbsent(null as string | null));
            if (content === null) continue;
            const parsed = parseCommandFile(content, f.name);
            out.push({ parsed, dir_path: f.full, scope });
        }
        return out;
    });

/**
 * Plugin commands live at
 *   `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/commands/`
 * and are auto-namespaced under the plugin id when invoked. We mirror that
 * here so the skill row name matches what `RELATE turn->invoked->skill`
 * writes from the transcript ingest.
 */
const readPluginCommands = (): Effect.Effect<
    CommandItem[],
    never,
    FileSystem.FileSystem | Path.Path
> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cacheRoot = path.join(homedir(), ".claude", "plugins", "cache");
        const out: CommandItem[] = [];
        // OLD: each readdir level guarded by try/catch → return/continue.
        const marketplaces = yield* fs.readDirectory(cacheRoot).pipe(orAbsent([] as string[]));
        for (const market of marketplaces) {
            const marketDir = path.join(cacheRoot, market);
            const plugins = yield* fs.readDirectory(marketDir).pipe(orAbsent([] as string[]));
            for (const plugin of plugins) {
                const pluginDir = path.join(marketDir, plugin);
                const versions = yield* fs.readDirectory(pluginDir).pipe(orAbsent([] as string[]));
                for (const version of versions) {
                    const commandsDir = path.join(pluginDir, version, "commands");
                    // Plugin commands share the `command` scope so all slash
                    // commands - user-level or plugin-shipped - look the same to
                    // `axctl taste / unused / stats`. The `dir_path` still
                    // disambiguates which plugin a command came from.
                    const items = yield* readCommandsRoot(
                        commandsDir,
                        "command",
                        plugin,
                    );
                    out.push(...items);
                }
            }
        }
        return out;
    });

const COMMAND_DIRS = (process.env.AX_COMMAND_DIRS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

function defaultCommandRoots(): { dir: string; scope: string }[] {
    if (COMMAND_DIRS.length > 0) {
        return COMMAND_DIRS.map((dir) => ({ dir, scope: "command" }));
    }
    // Pure path-string math in sync (non-Effect) code → posixPath.
    const roots: { dir: string; scope: string }[] = [
        { dir: posixPath.join(homedir(), ".claude", "commands"), scope: "command" },
    ];
    // Per-project `.claude/commands/` mirrors the per-project skills layout.
    // We only look at the cwd repo to keep ingest cheap; cross-repo command
    // discovery is intentionally out of scope (matches skills behaviour).
    const projectCmds = posixPath.join(process.cwd(), ".claude", "commands");
    if (projectCmds !== roots[0].dir) {
        roots.push({ dir: projectCmds, scope: "project-command" });
    }
    return roots;
}

const readProjectCommands = (): Effect.Effect<
    CommandItem[],
    never,
    FileSystem.FileSystem | Path.Path
> =>
    Effect.gen(function* () {
        const path = yield* Path.Path;
        // Per-project `<repo>/.claude/commands/` for every project the user has
        // worked in. Re-namespaced under the project basename so two repos with
        // the same bare command name don't collide and the resolver's `:bare`
        // suffix rule routes invocations correctly. discoverProjectRoots is an
        // Effect over FileSystem + Path; it owns its own tolerate-all recovery.
        const projects = yield* discoverProjectRoots();
        const out: CommandItem[] = [];
        for (const root of projects) {
            const commandsDir = path.join(root.path, ".claude", "commands");
            const items = yield* readCommandsRoot(
                commandsDir,
                `project-command:${root.name}`,
                root.name,
            );
            out.push(...items);
        }
        return out;
    });

const collectCommands = (): Effect.Effect<
    CommandItem[],
    never,
    FileSystem.FileSystem | Path.Path
> =>
    Effect.gen(function* () {
        const roots = defaultCommandRoots();
        const [fromBaseDirs, fromPlugins, fromProjects] = yield* Effect.all(
            [
                Effect.forEach(roots, ({ dir, scope }) => readCommandsRoot(dir, scope), {
                    concurrency: "unbounded",
                }).pipe(Effect.map((xs) => xs.flat())),
                readPluginCommands(),
                readProjectCommands(),
            ],
            { concurrency: "unbounded" },
        );
        const all = [...fromBaseDirs, ...fromPlugins, ...fromProjects];

        // Dedup by name. User-level dirs come first so they win over plugin
        // duplicates, mirroring how Claude resolves slash commands at runtime.
        const byName = new Map<string, CommandItem>();
        for (const item of all) {
            if (!byName.has(item.parsed.name)) byName.set(item.parsed.name, item);
        }
        return [...byName.values()];
    });

export const ingestCommands = (): Effect.Effect<
    { count: number },
    DbError,
    SurrealClient | FileSystem.FileSystem | Path.Path
> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const items = yield* collectCommands();

        yield* Effect.forEach(
            items,
            (item) => {
                const hash = createHash("sha256")
                    .update(item.parsed.body)
                    .digest("hex")
                    .slice(0, 16);
                // Schema is `option<string>` for description and bytes, so
                // coalesce to `undefined` (NONE) instead of leaving JS null.
                return upsertSkillByName(db, {
                    // Commands are catalog entries too - brand at the on-disk
                    // source like ingestSkills does.
                    name: SkillName.make(item.parsed.name),
                    scope: item.scope,
                    dir_path: item.dir_path,
                    description: item.parsed.description ?? undefined,
                    content_hash: hash,
                    bytes: item.parsed.bytes,
                });
            },
            { concurrency: 8, discard: true },
        );

        const count = items.length;
        yield* Effect.logDebug("commands upserted", { count });
        return { count };
    });

if (import.meta.main) {
    await Effect.runPromise(
        ingestCommands().pipe(Effect.provide(AppLayer), Effect.scoped) as Effect.Effect<
            { count: number }
        >,
    );
}

// ---------------------------------------------------------------------------
// Co-located StageDef
// ---------------------------------------------------------------------------

export const CommandsKey = Schema.Literal("commands");
export type CommandsKey = typeof CommandsKey.Type;

/**
 * Commands stage - seeds Command rows from `~/.claude/commands/`.
 *
 * Depends on: (none - leaf)
 * Consumed by: {@link ClaudeKey}, {@link CodexKey}
 * Tags: ingest
 */
export class CommandsStats extends BaseStageStats.extend<CommandsStats>("CommandsStats")({
    commandsUpserted: Schema.Number,
}) {}

export const commandsStage: StageDef<
    CommandsStats,
    SurrealClient | FileSystem.FileSystem | Path.Path
> = {
    meta: StageMeta.make({ key: "commands", deps: [], tags: ["ingest"] }),
    run: (_ctx: IngestContext) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const { count } = yield* ingestCommands();
            return CommandsStats.make({
                durationMs: Date.now() - t0,
                summary: `upserted ${count} command rows`,
                commandsUpserted: count,
            });
        }),
};
