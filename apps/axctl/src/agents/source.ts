import { createHash } from "node:crypto";
import { Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { HOME } from "@ax/lib/paths";
import { parseFrontmatter, readList } from "../config-core/frontmatter.ts";
import { ConfigParseError } from "../config-core/errors.ts";

/**
 * Agent definition source: Claude Code subagent files (`<dir>/<name>.md`) with
 * YAML frontmatter (`name, description, skills[], tools?, model?`). Two roots:
 *   - user    `~/.claude/agents/*.md`
 *   - project `<repo>/.claude/agents/*.md`
 *
 * Mirrors `SkillSource` shape (roots/installed/discover + remove/park/unpark)
 * but agent files are always writable, so there is no read-only variant. The
 * `skills:` frontmatter list IS the skill↔agent binding the shared
 * agent-frontmatter editor mutates; this module only READS it for the catalog.
 */

export type AgentScope = "user" | "project";

export interface AgentRecord {
    /** Canonical agent name (frontmatter `name`, else filename stem). */
    readonly name: string;
    readonly scope: AgentScope;
    /** Absolute path to the agent `.md` file. */
    readonly dirPath: string;
    readonly description?: string | undefined;
    readonly model?: string | undefined;
    /** Skill names declared in the `skills:` frontmatter list (sorted, deduped). */
    readonly skills: readonly string[];
    /** sha256 of the document body, first 16 hex chars (matches skill/command). */
    readonly contentHash: string;
    readonly bytes: number;
}

/** Sources are addressed by a stable `name` for the registry's `select`. */
export interface AgentSource {
    readonly name: string;
    readonly scope: AgentScope;
    /** Whether this source is read-only (always false today; kept for parity). */
    readonly readOnly: boolean;
    /**
     * Absolute agent-dir roots this source walks, given the resolved repo root
     * (used by the project source; the user source ignores it).
     */
    readonly roots: (repoRoot: string | undefined) => readonly string[];
    /** True when at least one root dir exists on disk. */
    readonly installed: (
        repoRoot: string | undefined,
    ) => Effect.Effect<boolean, PlatformError, FileSystem.FileSystem>;
    /** Discover all agent records under this source's roots. */
    readonly discover: (
        repoRoot: string | undefined,
    ) => Effect.Effect<AgentRecord[], ConfigParseError | PlatformError, FileSystem.FileSystem | Path.Path>;
    /** Delete an agent file (hard). */
    readonly remove: (
        rec: AgentRecord,
    ) => Effect.Effect<void, ConfigParseError, FileSystem.FileSystem>;
    /** Move an agent file aside to `<file>.ax-parked` (disabled, recoverable). */
    readonly park: (
        rec: AgentRecord,
    ) => Effect.Effect<void, ConfigParseError, FileSystem.FileSystem>;
    /** Restore a parked agent file. */
    readonly unpark: (
        rec: AgentRecord,
    ) => Effect.Effect<void, ConfigParseError, FileSystem.FileSystem>;
}

const hashBody = (body: string): string =>
    createHash("sha256").update(body).digest("hex").slice(0, 16);

/** `AX_AGENT_DIRS` (comma list) overrides the user root, for tests. */
const envUserDirs = (): string[] =>
    (process.env.AX_AGENT_DIRS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

const PARKED_SUFFIX = ".ax-parked";

/**
 * Parse one agent file into a record. Frontmatter is required to extract a
 * stable name/skills; a file with NO frontmatter still yields a record keyed by
 * its filename stem (mirrors skills' tolerant behaviour). Only a genuinely
 * unreadable file surfaces a ConfigParseError to the caller.
 */
const parseAgentFile = (
    fullPath: string,
    fallbackName: string,
    scope: AgentScope,
): Effect.Effect<AgentRecord, ConfigParseError, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const content = yield* fs.readFileString(fullPath).pipe(
            Effect.mapError(
                (e) =>
                    new ConfigParseError({
                        file: fullPath,
                        reason: `unreadable agent file: ${String(e)}`,
                    }),
            ),
        );
        const parsed = parseFrontmatter(content);
        const fm = parsed.frontmatter;
        const name = typeof fm.name === "string" && fm.name.length > 0 ? fm.name : fallbackName;
        const description = typeof fm.description === "string" ? fm.description : undefined;
        const model = typeof fm.model === "string" ? fm.model : undefined;
        const skills = Array.from(new Set(readList(fm, "skills"))).sort();
        return {
            name,
            scope,
            dirPath: fullPath,
            description,
            model,
            skills,
            contentHash: hashBody(parsed.body),
            bytes: Buffer.byteLength(content, "utf8"),
        } satisfies AgentRecord;
    });

/** Walk one agent-dir root, parse every `*.md` (skipping parked sidecars). */
const discoverRoot = (
    dir: string,
    scope: AgentScope,
): Effect.Effect<AgentRecord[], ConfigParseError | PlatformError, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        if (!(yield* fs.exists(dir))) return [];
        const entries = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => [] as string[]));
        const out: AgentRecord[] = [];
        for (const entry of entries) {
            if (!entry.endsWith(".md")) continue;
            if (entry.endsWith(PARKED_SUFFIX)) continue;
            const full = path.join(dir, entry);
            const type = yield* fs
                .stat(full)
                .pipe(Effect.map((s) => s.type), Effect.orElseSucceed(() => "Unknown" as const));
            if (type !== "File") continue;
            const stem = entry.replace(/\.md$/, "");
            out.push(yield* parseAgentFile(full, stem, scope));
        }
        return out;
    });

const makeSource = (
    name: string,
    scope: AgentScope,
    roots: (repoRoot: string | undefined) => readonly string[],
): AgentSource => {
    const wrapFs = (op: string, file: string) => (e: unknown) =>
        new ConfigParseError({ file, reason: `${op} failed: ${String(e)}` });

    return {
        name,
        scope,
        readOnly: false,
        roots,
        installed: (repoRoot) =>
            Effect.gen(function* () {
                const fs = yield* FileSystem.FileSystem;
                for (const dir of roots(repoRoot)) {
                    if (yield* fs.exists(dir)) return true;
                }
                return false;
            }),
        discover: (repoRoot) =>
            Effect.gen(function* () {
                const all: AgentRecord[] = [];
                for (const dir of roots(repoRoot)) {
                    all.push(...(yield* discoverRoot(dir, scope)));
                }
                return all;
            }),
        remove: (rec) =>
            Effect.gen(function* () {
                const fs = yield* FileSystem.FileSystem;
                yield* fs
                    .remove(rec.dirPath)
                    .pipe(Effect.mapError(wrapFs("remove", rec.dirPath)));
            }),
        park: (rec) =>
            Effect.gen(function* () {
                const fs = yield* FileSystem.FileSystem;
                yield* fs
                    .rename(rec.dirPath, `${rec.dirPath}${PARKED_SUFFIX}`)
                    .pipe(Effect.mapError(wrapFs("park", rec.dirPath)));
            }),
        unpark: (rec) =>
            Effect.gen(function* () {
                const fs = yield* FileSystem.FileSystem;
                yield* fs
                    .rename(`${rec.dirPath}${PARKED_SUFFIX}`, rec.dirPath)
                    .pipe(Effect.mapError(wrapFs("unpark", rec.dirPath)));
            }),
    };
};

/** User source: `~/.claude/agents/*.md` (or `AX_AGENT_DIRS` override). */
export const userSource: AgentSource = makeSource("user", "user", () => {
    const fromEnv = envUserDirs();
    if (fromEnv.length > 0) return fromEnv;
    return [`${HOME}/.claude/agents`];
});

/** Project source: `<repo>/.claude/agents/*.md`. No repoRoot ⇒ no roots. */
export const projectSource: AgentSource = makeSource("project", "project", (repoRoot) =>
    repoRoot ? [`${repoRoot}/.claude/agents`] : [],
);
