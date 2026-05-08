import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { connect, RecordId } from "../lib/db.ts";
import { defaultSkillDirs } from "../lib/paths.ts";
import { skillRecordKey } from "../lib/skill-id.ts";

interface ParsedSkill {
    name: string;
    description: string | undefined;
    frontmatter: Record<string, unknown>;
    body: string;
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

function parseSkillFile(content: string, fallbackName: string): ParsedSkill {
    const m = content.match(FRONTMATTER_RE);
    if (!m) {
        return { name: fallbackName, description: undefined, frontmatter: {}, body: content };
    }
    let fm: Record<string, unknown> = {};
    try {
        fm = (parseYaml(m[1]) ?? {}) as Record<string, unknown>;
    } catch {
        // Skill frontmatter often contains unquoted colons in descriptions -
        // fall back to a tolerant line parser.
        fm = looseLineParse(m[1]);
    }
    return {
        name: typeof fm.name === "string" ? fm.name : fallbackName,
        description: typeof fm.description === "string" ? fm.description : undefined,
        frontmatter: fm,
        body: m[2],
    };
}

async function readSkillDir(
    dir: string,
    scope: string,
): Promise<Array<{ skill: ParsedSkill; dir_path: string; bytes: number; scope: string }>> {
    const out: Array<{
        skill: ParsedSkill;
        dir_path: string;
        bytes: number;
        scope: string;
    }> = [];
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

async function readPluginSkills(): Promise<
    Array<{ skill: ParsedSkill; dir_path: string; bytes: number; scope: string }>
> {
    const root = join(process.env.HOME!, ".claude", "plugins", "cache");
    const out: Array<{
        skill: ParsedSkill;
        dir_path: string;
        bytes: number;
        scope: string;
    }> = [];
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

export async function ingestSkills(): Promise<{ count: number }> {
    const db = await connect();
    try {
        const buckets = defaultSkillDirs();
        const fromBaseDirs = (
            await Promise.all(buckets.map(({ dir, scope }) => readSkillDir(dir, scope)))
        ).flat();
        const fromPlugins = await readPluginSkills();
        const all = [...fromBaseDirs, ...fromPlugins];

        // Dedup by name keeping highest-precedence (user dirs first, plugins last is fine)
        const byName = new Map<string, (typeof all)[number]>();
        for (const item of all) {
            if (!byName.has(item.skill.name)) byName.set(item.skill.name, item);
        }

        let count = 0;
        for (const item of byName.values()) {
            const hash = createHash("sha256")
                .update(item.skill.body)
                .digest("hex")
                .slice(0, 16);
            const id = new RecordId("skill", skillRecordKey(item.skill.name));
            await db.upsert(id).content({
                name: item.skill.name,
                scope: item.scope,
                dir_path: item.dir_path,
                description: item.skill.description ?? null,
                frontmatter: JSON.stringify(item.skill.frontmatter),
                content_hash: hash,
                bytes: item.bytes,
            });
            count++;
        }
        console.log(`[skills] upserted ${count}`);
        return { count };
    } finally {
        await db.close();
    }
}

if (import.meta.main) {
    await ingestSkills();
}
