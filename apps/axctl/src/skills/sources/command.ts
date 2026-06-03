import { Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { SkillParseError } from "@ax/lib/errors";
import { sha16 } from "../../config-core/hash.ts";
import { parseFrontmatter } from "../../config-core/frontmatter.ts";
import { SkillReadOnlyError } from "../errors.ts";
import {
    PARKED_DIRNAME,
    type SkillDirRef,
    type SkillRecord,
    type SkillSource,
} from "./types.ts";


const firstNonEmptyLine = (body: string): string | undefined => {
    for (const line of body.split("\n")) {
        const t = line.trim();
        if (t) return t.slice(0, 500);
    }
    return undefined;
};

/**
 * Recursively walk a commands root, mirroring `ingest/commands.ts`:
 * subdirectories become a `:`-joined namespace prefix on the command name
 * (`commands/gsd/plan-phase.md` -> `gsd:plan-phase`).
 */
const walk = (
    root: string,
    prefix: string,
): Effect.Effect<ReadonlyArray<{ name: string; full: string }>, PlatformError, FileSystem.FileSystem | Path.Path> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        if (!(yield* fs.exists(root))) return [];
        const entries = yield* fs
            .readDirectory(root)
            .pipe(Effect.orElseSucceed(() => [] as string[]));
        const out: { name: string; full: string }[] = [];
        for (const entry of entries) {
            if (entry === PARKED_DIRNAME) continue;
            const full = path.join(root, entry);
            const type = yield* fs
                .stat(full)
                .pipe(Effect.map((s) => s.type), Effect.orElseSucceed(() => "Unknown" as const));
            if (type === "Directory") {
                const sub = yield* walk(full, prefix ? `${prefix}:${entry}` : entry);
                out.push(...sub);
                continue;
            }
            if (type !== "File" || !entry.endsWith(".md")) continue;
            const base = entry.slice(0, -3);
            if (base.toUpperCase() === "README") continue;
            out.push({ name: prefix ? `${prefix}:${base}` : base, full });
        }
        return out;
    });

/**
 * Flat-`.md` command source codec (the `unit:"md"` outlier). Commands live as
 * single `.md` files under `~/.claude/commands/` (and per-repo) and are
 * upserted into the same `skill` table with scope `command`/`project-command`.
 * `remove`/`park` operate on the file, not a dir.
 */
export const makeCommandSource = (config: {
    readonly label: string;
    readonly writable: boolean;
    readonly roots: (repoRoot: string | null) => ReadonlyArray<SkillDirRef>;
    readonly installed?: (
        repoRoot: string | null,
    ) => Effect.Effect<boolean, never, FileSystem.FileSystem>;
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
                    source: "command",
                    reason: "command source is read-only",
                }),
            );

    const discover = (
        ref: SkillDirRef,
    ): Effect.Effect<ReadonlyArray<SkillRecord>, SkillParseError | PlatformError, FileSystem.FileSystem | Path.Path> =>
        Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const files = yield* walk(ref.root, "");
            const out: SkillRecord[] = [];
            for (const f of files) {
                const content = yield* fs
                    .readFileString(f.full)
                    .pipe(
                        Effect.mapError(
                            (e) =>
                                new SkillParseError({
                                    file: f.full,
                                    reason: `read failed: ${String(e)}`,
                                }),
                        ),
                    );
                const parsed = parseFrontmatter(content);
                const fm = parsed.frontmatter;
                const description =
                    typeof fm.description === "string"
                        ? fm.description
                        : firstNonEmptyLine(parsed.hasFrontmatter ? parsed.body : content);
                out.push({
                    name: f.name,
                    source: "command",
                    scopeTag: ref.scope,
                    dirPath: f.full,
                    unit: "md",
                    description,
                    roles: [],
                    bytes: Buffer.byteLength(content, "utf8"),
                    contentHash: sha16(parsed.hasFrontmatter ? parsed.body : content),
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
            yield* fs.remove(rec.dirPath);
        });

    const park = (
        rec: SkillRecord,
    ): Effect.Effect<void, SkillReadOnlyError | PlatformError, FileSystem.FileSystem | Path.Path> =>
        Effect.gen(function* () {
            yield* assertWritable(rec.name, rec.writable);
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const parkedRoot = path.join(path.dirname(rec.dirPath), PARKED_DIRNAME);
            yield* fs.makeDirectory(parkedRoot, { recursive: true });
            yield* fs.rename(rec.dirPath, path.join(parkedRoot, path.basename(rec.dirPath)));
        });

    const unpark = (
        name: string,
        ref: SkillDirRef,
    ): Effect.Effect<void, SkillReadOnlyError | PlatformError, FileSystem.FileSystem | Path.Path> =>
        Effect.gen(function* () {
            yield* assertWritable(name, ref.writable);
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const bare = name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name;
            const file = `${bare}.md`;
            const parkedRoot = path.join(ref.root, PARKED_DIRNAME);
            yield* fs.makeDirectory(ref.root, { recursive: true });
            yield* fs.rename(path.join(parkedRoot, file), path.join(ref.root, file));
        });

    return {
        name: "command",
        label: config.label,
        writable: config.writable,
        roots: config.roots,
        installed:
            config.installed ??
            ((repoRoot) => Effect.succeed(config.roots(repoRoot).length > 0)),
        discover,
        remove,
        park,
        unpark,
    };
};
