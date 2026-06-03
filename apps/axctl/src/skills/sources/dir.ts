import { Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { SkillParseError } from "@ax/lib/errors";
import { sha16 } from "../../config-core/hash.ts";
import { validateRoleName } from "@ax/lib/role-name";
import { parseFrontmatter, readList } from "../../config-core/frontmatter.ts";
import { SkillReadOnlyError } from "../errors.ts";
import {
    PARKED_DIRNAME,
    type SkillDirRef,
    type SkillRecord,
    type SkillScope,
    type SkillSource,
} from "./types.ts";

const SKILL_FILE = "SKILL.md";

/** Roles from a skill's `role:` frontmatter, normalized; bad entries dropped. */
const extractRoles = (fm: Record<string, unknown>): string[] => {
    const out: string[] = [];
    for (const raw of readList(fm, "role")) {
        try {
            out.push(validateRoleName(raw));
        } catch {
            // frontmatter typo - silently skip (matches ingest/skills.ts)
        }
    }
    return out;
};


/**
 * Apply a source's name-namespacing rule. Plugin + project skills get the bare
 * SKILL.md `name` re-namespaced to `<prefix>:<name>` (mirrors ingest/skills.ts)
 * so two repos/plugins with the same bare name don't collide and the `:bare`
 * resolver rule attaches invocations. The prefix is the last path segment of
 * the scope tag (`plugin:caveman` -> `caveman`, `project:ax` -> `ax`).
 */
const namespaced = (bareName: string, scopeTag: string): string => {
    if (bareName.includes(":")) return bareName;
    const colon = scopeTag.indexOf(":");
    if (colon < 0) return bareName;
    const prefix = scopeTag.slice(colon + 1);
    return prefix ? `${prefix}:${bareName}` : bareName;
};

/**
 * Shared dir-source codec. All five dir-based sources (user, agents-shared,
 * codex, plugin, project) differ only in their `roots()`/`writable`/`scope`
 * config - the walk + parse + mutate is identical, so it lives here once.
 *
 * `remove`/`park` are symlink-safe: `fs.remove` operates on the link entry
 * itself, never `realpath`-ing into a dotfiles repo (stow). `park` renames the
 * whole dir into a sibling `.ax-parked/`.
 */
export const makeDirSource = (config: {
    readonly name: SkillScope;
    readonly label: string;
    readonly writable: boolean;
    readonly roots: (repoRoot: string | null) => ReadonlyArray<SkillDirRef>;
    readonly installed?: (repoRoot: string | null) => boolean;
}): SkillSource => {
    const assertWritable = (
        name: string,
        writable: boolean,
    ): Effect.Effect<void, SkillReadOnlyError> =>
        writable
            ? Effect.void
            : Effect.fail(
                new SkillReadOnlyError({
                    name,
                    source: config.name,
                    reason: `${config.name} source is read-only (managed elsewhere)`,
                }),
            );

    const discover = (
        ref: SkillDirRef,
    ): Effect.Effect<ReadonlyArray<SkillRecord>, SkillParseError | PlatformError, FileSystem.FileSystem | Path.Path> =>
        Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            if (!(yield* fs.exists(ref.root))) return [];
            const entries = yield* fs
                .readDirectory(ref.root)
                .pipe(Effect.orElseSucceed(() => [] as string[]));
            const out: SkillRecord[] = [];
            for (const entry of entries) {
                if (entry === PARKED_DIRNAME) continue;
                const dir = path.join(ref.root, entry);
                const info = yield* fs
                    .stat(dir)
                    .pipe(Effect.map((s) => s.type), Effect.orElseSucceed(() => "Unknown" as const));
                if (info !== "Directory") continue;
                const skillFile = path.join(dir, SKILL_FILE);
                if (!(yield* fs.exists(skillFile))) continue;
                const content = yield* fs
                    .readFileString(skillFile)
                    .pipe(
                        Effect.mapError(
                            (e) =>
                                new SkillParseError({
                                    file: skillFile,
                                    reason: `read failed: ${String(e)}`,
                                }),
                        ),
                    );
                const parsed = parseFrontmatter(content);
                const fm = parsed.frontmatter;
                const bareName = typeof fm.name === "string" && fm.name.length > 0 ? fm.name : entry;
                const name = namespaced(bareName, ref.scope);
                out.push({
                    name,
                    source: config.name,
                    scopeTag: ref.scope,
                    dirPath: dir,
                    unit: "dir",
                    description: typeof fm.description === "string" ? fm.description : undefined,
                    roles: extractRoles(fm),
                    bytes: Buffer.byteLength(content, "utf8"),
                    contentHash: sha16(parsed.body),
                    writable: ref.writable,
                });
            }
            return out;
        });

    const remove = (
        rec: SkillRecord,
    ): Effect.Effect<void, SkillReadOnlyError | PlatformError, FileSystem.FileSystem | Path.Path> =>
        Effect.gen(function* () {
            yield* assertWritable(rec.name, rec.writable);
            const fs = yield* FileSystem.FileSystem;
            // `recursive` clears the dir tree. For a symlinked skill dir the
            // entry IS the link; `remove` unlinks it without chasing realpath.
            yield* fs.remove(rec.dirPath, { recursive: true });
        });

    const park = (
        rec: SkillRecord,
    ): Effect.Effect<void, SkillReadOnlyError | PlatformError, FileSystem.FileSystem | Path.Path> =>
        Effect.gen(function* () {
            yield* assertWritable(rec.name, rec.writable);
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const parentRoot = path.dirname(rec.dirPath);
            const parkedRoot = path.join(parentRoot, PARKED_DIRNAME);
            yield* fs.makeDirectory(parkedRoot, { recursive: true });
            const dest = path.join(parkedRoot, path.basename(rec.dirPath));
            yield* fs.rename(rec.dirPath, dest);
        });

    const unpark = (
        name: string,
        ref: SkillDirRef,
    ): Effect.Effect<void, SkillReadOnlyError | PlatformError, FileSystem.FileSystem | Path.Path> =>
        Effect.gen(function* () {
            yield* assertWritable(name, ref.writable);
            const path = yield* Path.Path;
            const fs = yield* FileSystem.FileSystem;
            // Parked dir basename is the on-disk dir name, not the namespaced
            // record name; strip any `prefix:` to recover the bare segment.
            const bare = name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name;
            const parkedRoot = path.join(ref.root, PARKED_DIRNAME);
            const src = path.join(parkedRoot, bare);
            const dest = path.join(ref.root, bare);
            yield* fs.makeDirectory(ref.root, { recursive: true });
            yield* fs.rename(src, dest);
        });

    return {
        name: config.name,
        label: config.label,
        writable: config.writable,
        roots: config.roots,
        installed:
            config.installed ?? ((repoRoot) => config.roots(repoRoot).length > 0),
        discover,
        remove,
        park,
        unpark,
    };
};
