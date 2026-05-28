import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import { defaultSkillDirs } from "../lib/paths.ts";
import { AppLayer } from "../lib/layers.ts";
import type { DbError } from "../lib/errors.ts";
import { upsertSkillByName } from "./skill-upsert.ts";
import { relateSkillRoles } from "./skill-role.ts";
import { discoverProjectRoots } from "./project-discovery.ts";
import { validateRoleName } from "../lib/role-name.ts";

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

async function readSkillDir(dir: string, scope: string): Promise<SkillItem[]> {
    const out: SkillItem[] = [];
    let entries: string[];
    try {
        entries = await readdir(dir);
    } catch {
        return out;
    }
    for (const entry of entries) {
        const full = join(dir, entry);
        let st;
        try {
            st = await stat(full);
        } catch {
            continue;
        }
        if (!st.isDirectory()) continue;
        const skillFile = join(full, "SKILL.md");
        let content: string;
        try {
            content = await readFile(skillFile, "utf8");
        } catch {
            continue;
        }
        const parsed = parseSkillFile(content, entry);
        out.push({
            skill: parsed,
            dir_path: full,
            bytes: Buffer.byteLength(content, "utf8"),
            scope,
        });
    }
    return out;
}

async function readPluginSkills(): Promise<SkillItem[]> {
    const root = join(process.env.HOME!, ".claude", "plugins", "cache");
    const out: SkillItem[] = [];
    let marketplaces: string[];
    try {
        marketplaces = await readdir(root);
    } catch {
        return out;
    }
    for (const market of marketplaces) {
        const marketDir = join(root, market);
        let plugins: string[];
        try {
            plugins = await readdir(marketDir);
        } catch {
            continue;
        }
        for (const plugin of plugins) {
            const pluginDir = join(marketDir, plugin);
            let versions: string[];
            try {
                versions = await readdir(pluginDir);
            } catch {
                continue;
            }
            for (const version of versions) {
                const skillsDir = join(pluginDir, version, "skills");
                const items = await readSkillDir(skillsDir, `plugin:${plugin}`);
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
}

async function readProjectSkills(): Promise<SkillItem[]> {
    const roots = await discoverProjectRoots();
    const out: SkillItem[] = [];
    for (const root of roots) {
        const skillsDir = join(root.path, ".claude", "skills");
        const items = await readSkillDir(skillsDir, `project:${root.name}`);
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
}

const collectSkills = (): Effect.Effect<SkillItem[]> =>
    Effect.promise(async () => {
        const buckets = defaultSkillDirs();
        const [fromBaseDirs, fromPlugins, fromProjects] = await Promise.all([
            Promise.all(buckets.map(({ dir, scope }) => readSkillDir(dir, scope))).then((xs) => xs.flat()),
            readPluginSkills(),
            readProjectSkills(),
        ]);
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
    SurrealClient
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
                        name: item.skill.name,
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
