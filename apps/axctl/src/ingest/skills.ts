/**
 * @stage skills
 * @rationale Skills are the agent's standing instructions. Indexing them
 *   up-front means later stages can ask "which skills exist" without
 *   re-walking the filesystem on every query, and the dashboard can show a
 *   static catalogue without reading transcripts at all.
 * @inputs ~/.claude/skills/, ~/.agents/skills/, plugin caches
 * @outputs `skill` rows, `plays_role` edges
 * @order 10
 *
 * @see scripts/extract-stage-rationale.ts for the full annotation contract.
 */
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { Effect, FileSystem, Path, Schema } from "effect";
import { SurrealClient } from "@ax/lib/db";
import { SkillName } from "@ax/lib/brands";
import { defaultSkillDirs, skillDirsOverridden } from "@ax/lib/paths";
import { AppLayer } from "@ax/lib/layers";
import type { DbError } from "@ax/lib/errors";
import { upsertSkillByName } from "./skill-upsert.ts";
import { relateSkillRoles } from "./skill-role.ts";
import { discoverProjectRoots } from "./project-discovery.ts";
import { BaseStageStats, IngestContext, StageMeta } from "./stage/types.ts";
import type { StageDef } from "./stage/registry.ts";
import { validateRoleName } from "@ax/lib/role-name";
import { orAbsent } from "@ax/lib/shared/fs-error";

interface ParsedSkill {
    name: string;
    description: string | undefined;
    frontmatter: Record<string, unknown>;
    body: string;
    roles: string[];
}

interface SkillItem {
    skill: ParsedSkill;
    dir_path: string;
    bytes: number;
    scope: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

function looseLineParse(raw: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const m = line.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/);
        if (!m) continue;
        const [, key, value] = m;
        if (value !== "") {
            out[key] = value.replace(/^["']|["']$/g, "");
            continue;
        }
        // Empty value: look ahead for `  - item` list lines.
        const listItems: string[] = [];
        while (i + 1 < lines.length) {
            const next = lines[i + 1]!;
            const lm = next.match(/^\s+-\s+(.+)$/);
            if (!lm) break;
            listItems.push(lm[1]!.trim());
            i++;
        }
        if (listItems.length > 0) {
            out[key] = listItems;
        }
        // If no list items found, key is omitted (empty value stays absent).
    }
    return out;
}

function extractRoles(fm: Record<string, unknown>, skillName?: string): string[] {
    const raw = fm["role"];
    if (raw === undefined || raw === null || raw === "") return [];
    const items = Array.isArray(raw) ? raw : [raw];
    const result: string[] = [];
    for (const item of items) {
        if (typeof item !== "string") continue;
        try {
            const norm = validateRoleName(item);
            result.push(norm);
        } catch (err) {
            // Frontmatter typo - silently skip. The Effect.logWarning call
            // below is deferred to the ingest pipeline context where an Effect
            // runtime is available. Here we just omit the bad entry.
            void Effect.logWarning(
                `skills: skipping invalid role "${item}" in skill "${skillName ?? "unknown"}" frontmatter: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }
    return result;
}

function parseSkillFile(content: string, fallbackName: string): ParsedSkill {
    const m = content.match(FRONTMATTER_RE);
    if (!m) {
        return { name: fallbackName, description: undefined, frontmatter: {}, body: content, roles: [] };
    }
    let fm: Record<string, unknown> = {};
    try {
        fm = (parseYaml(m[1]) ?? {}) as Record<string, unknown>;
    } catch {
        // Skill frontmatter often contains unquoted colons in descriptions -
        // fall back to a tolerant line parser.
        fm = looseLineParse(m[1]);
    }
    const name = typeof fm.name === "string" ? fm.name : fallbackName;
    return {
        name,
        description: typeof fm.description === "string" ? fm.description : undefined,
        frontmatter: fm,
        body: m[2],
        roles: extractRoles(fm, name),
    };
}

// Every fs op below is wrapped in `orAbsent`, which clears the PlatformError E
// channel (any discovery miss / unreadable dir recovers to a fallback - exactly
// the old per-call try/catch tolerance). So the readers never fail; R is just
// FileSystem + Path.
type FsReader = Effect.Effect<SkillItem[], never, FileSystem.FileSystem | Path.Path>;

const readSkillDir = (dir: string, scope: string): FsReader =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const out: SkillItem[] = [];
        // OLD: try/catch around readdir → return []. A missing/unreadable dir is
        // a tolerated discovery miss, so recover ANY PlatformError to [].
        const entries = yield* fs.readDirectory(dir).pipe(orAbsent([] as string[]));
        for (const entry of entries) {
            const full = path.join(dir, entry);
            // OLD: stat in try/catch → continue on error; skip non-directories.
            // orAbsent(false) treats any stat fault as "not a directory, skip".
            const isDir = yield* fs.stat(full).pipe(
                Effect.map((st) => st.type === "Directory"),
                orAbsent(false),
            );
            if (!isDir) continue;
            const skillFile = path.join(full, "SKILL.md");
            // OLD: readFile in try/catch → continue (skip dir without SKILL.md).
            // orAbsent(null) recovers any read fault to "no skill here".
            const content = yield* fs.readFileString(skillFile).pipe(orAbsent(null as string | null));
            if (content === null) continue;
            const parsed = parseSkillFile(content, entry);
            out.push({
                skill: parsed,
                dir_path: full,
                bytes: Buffer.byteLength(content, "utf8"),
                scope,
            });
        }
        return out;
    });

const readPluginSkills = (): FsReader =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = path.join(process.env.HOME!, ".claude", "plugins", "cache");
        const out: SkillItem[] = [];
        // OLD: each readdir level guarded by try/catch → return/continue.
        const marketplaces = yield* fs.readDirectory(root).pipe(orAbsent([] as string[]));
        for (const market of marketplaces) {
            const marketDir = path.join(root, market);
            const plugins = yield* fs.readDirectory(marketDir).pipe(orAbsent([] as string[]));
            for (const plugin of plugins) {
                const pluginDir = path.join(marketDir, plugin);
                const versions = yield* fs.readDirectory(pluginDir).pipe(orAbsent([] as string[]));
                for (const version of versions) {
                    const skillsDir = path.join(pluginDir, version, "skills");
                    const items = yield* readSkillDir(skillsDir, `plugin:${plugin}`);
                    items.forEach((it) => {
                        // Re-namespace skill name to plugin:skillname for plugin-scoped skills
                        if (!it.skill.name.includes(":")) {
                            it.skill.name = `${plugin}:${it.skill.name}`;
                        }
                    });
                    out.push(...items);
                }
            }
        }
        return out;
    });

const readProjectSkills = (): FsReader =>
    Effect.gen(function* () {
        const path = yield* Path.Path;
        // discoverProjectRoots is an Effect over FileSystem + Path; it owns its
        // own tolerate-all recovery internally (cannot fail).
        const roots = yield* discoverProjectRoots();
        const out: SkillItem[] = [];
        for (const root of roots) {
            const skillsDir = path.join(root.path, ".claude", "skills");
            const items = yield* readSkillDir(skillsDir, `project:${root.name}`);
            // Re-namespace under the project so two repos with the same bare
            // skill name (`expo-deployment`) don't collide in the catalog and
            // the resolver's `:bare` suffix rule attaches invocations correctly.
            items.forEach((it) => {
                if (!it.skill.name.includes(":")) {
                    it.skill.name = `${root.name}:${it.skill.name}`;
                }
            });
            out.push(...items);
        }
        return out;
    });

const collectSkills = (): Effect.Effect<
    SkillItem[],
    never,
    FileSystem.FileSystem | Path.Path
> =>
    Effect.gen(function* () {
        const buckets = defaultSkillDirs();
        // AX_SKILLS_DIRS is a full override: when set (tests, sandboxes), plugin + project discovery is skipped so collection stays hermetic.
        if (skillDirsOverridden()) {
            return yield* Effect.forEach(buckets, ({ dir, scope }) => readSkillDir(dir, scope), {
                concurrency: "unbounded",
            }).pipe(Effect.map((xs) => xs.flat()));
        }
        const [fromBaseDirs, fromPlugins, fromProjects] = yield* Effect.all(
            [
                Effect.forEach(buckets, ({ dir, scope }) => readSkillDir(dir, scope), {
                    concurrency: "unbounded",
                }).pipe(Effect.map((xs) => xs.flat())),
                readPluginSkills(),
                readProjectSkills(),
            ],
            { concurrency: "unbounded" },
        );
        const all = [...fromBaseDirs, ...fromPlugins, ...fromProjects];

        // Dedup by name keeping highest-precedence (user dirs first, plugins last is fine)
        const byName = new Map<string, SkillItem>();
        for (const item of all) {
            if (!byName.has(item.skill.name)) byName.set(item.skill.name, item);
        }
        return [...byName.values()];
    });

export const ingestSkills = (): Effect.Effect<
    { count: number; rolesUpserted: number; edgesWritten: number },
    DbError,
    SurrealClient | FileSystem.FileSystem | Path.Path
> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const items = yield* collectSkills();

        let rolesUpserted = 0;
        let edgesWritten = 0;

        yield* Effect.forEach(
            items,
            (item) => {
                const hash = createHash("sha256")
                    .update(item.skill.body)
                    .digest("hex")
                    .slice(0, 16);
                return Effect.gen(function* () {
                    const skillId = yield* upsertSkillByName(db, {
                        // On-disk catalog is the canonical source of skill
                        // names - brand here so the record-key path stays
                        // SkillName end-to-end.
                        name: SkillName.make(item.skill.name),
                        scope: item.scope,
                        dir_path: item.dir_path,
                        description: item.skill.description ?? null,
                        content_hash: hash,
                        bytes: item.bytes,
                    });
                    const roleStats = yield* relateSkillRoles(db, {
                        skillId,
                        roles: item.skill.roles,
                    });
                    rolesUpserted += roleStats.rolesUpserted;
                    edgesWritten += roleStats.edgesWritten;
                });
            },
            { concurrency: 8, discard: true },
        );

        const count = items.length;
        yield* Effect.logDebug("skills upserted", { count, rolesUpserted, edgesWritten });
        return { count, rolesUpserted, edgesWritten };
    });

if (import.meta.main) {
    await Effect.runPromise(
        ingestSkills().pipe(Effect.provide(AppLayer), Effect.scoped) as Effect.Effect<
            { count: number; rolesUpserted: number; edgesWritten: number }
        >,
    );
}

// ---------------------------------------------------------------------------
// Co-located StageDef - canonical pattern for Tasks 7–20
// ---------------------------------------------------------------------------

export const SkillsKey = Schema.Literal("skills");
export type SkillsKey = typeof SkillsKey.Type;

/**
 * Per-run stats emitted by the skills stage.
 */
export class SkillsStats extends BaseStageStats.extend<SkillsStats>("SkillsStats")({
    skillsUpserted: Schema.Number,
}) {}

/**
 * Skills stage - seeds Skill rows from `~/.claude/skills/` + `~/.agents/skills/`.
 *
 * Depends on: (none - leaf)
 * Consumed by: {@link ClaudeKey}, {@link CodexKey} via `invoked` edges.
 * Tags: ingest
 */
export const skillsStage: StageDef<
    SkillsStats,
    SurrealClient | FileSystem.FileSystem | Path.Path
> = {
    meta: StageMeta.make({ key: "skills", deps: [], tags: ["ingest"] }),
    run: (_ctx: IngestContext) =>
        Effect.gen(function* () {
            const t0 = Date.now();
            const { count } = yield* ingestSkills();
            return SkillsStats.make({
                durationMs: Date.now() - t0,
                summary: `upserted ${count} skill rows`,
                skillsUpserted: count,
            });
        }),
};
