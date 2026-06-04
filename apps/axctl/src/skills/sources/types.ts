import type { Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import type { SkillParseError } from "@ax/lib/errors";
import type { SkillReadOnlyError } from "../errors.ts";

/**
 * The six on-disk skill provenance buckets. Mirrors the source matrix in the
 * plan (`ax-skills-config.md`). `command` is the flat-`.md` outlier; the rest
 * are SKILL.md dirs.
 */
export type SkillScope =
    | "user"
    | "agents-shared"
    | "codex"
    | "plugin"
    | "project"
    | "command";

/**
 * One discoverable root for a source. A single source may expose several roots
 * (e.g. plugin caches fan out per marketplace/plugin/version; project skills
 * fan out per repo). `writable` is the per-root override of the source default
 * (codex `.system` roots are read-only even though the codex source is writable).
 */
export interface SkillDirRef {
    /** Absolute directory to walk. For `command`, the commands root. */
    readonly root: string;
    /** Scope tag stamped onto every record discovered under this root. */
    readonly scope: string;
    /** Whether mutators may touch records discovered under this root. */
    readonly writable: boolean;
}

/**
 * A normalized on-disk skill (or command) record. `name` keeps the `:`
 * plugin-namespacing convention so the `skill-id.ts` `:`→`__` record-key rule
 * stays stable. `dirPath` is the SKILL.md dir for `unit:"dir"` and the `.md`
 * file itself for `unit:"md"`.
 */
export interface SkillRecord {
    readonly name: string;
    readonly source: SkillScope;
    readonly scopeTag: string;
    readonly dirPath: string;
    readonly unit: "dir" | "md";
    readonly description?: string | undefined;
    readonly roles: ReadonlyArray<string>;
    readonly bytes: number;
    readonly contentHash: string;
    /** Whether the discovering root marked this record writable. */
    readonly writable: boolean;
}

/**
 * A skill source adapter: read (`discover`) + lifecycle mutators. All
 * effect-returning; fallible work surfaces as tagged errors, never thrown
 * defects. Read-only sources fail mutators with `SkillReadOnlyError` BEFORE
 * touching disk.
 */
export interface SkillSource {
    readonly name: SkillScope;
    readonly label: string;
    /** Source-level default; a root may still be read-only via its `SkillDirRef`. */
    readonly writable: boolean;
    /** Roots to walk; `repoRoot` scopes the project/command per-repo roots. */
    readonly roots: (
        repoRoot: string | null,
    ) => Effect.Effect<ReadonlyArray<SkillDirRef>, never, FileSystem.FileSystem | Path.Path>;
    /** Cheap "is this source present on this machine/repo" check. */
    readonly installed: (
        repoRoot: string | null,
    ) => Effect.Effect<boolean, never, FileSystem.FileSystem>;
    readonly discover: (
        ref: SkillDirRef,
    ) => Effect.Effect<ReadonlyArray<SkillRecord>, SkillParseError | PlatformError, FileSystem.FileSystem | Path.Path>;
    /** Delete the record on disk (unlink, symlink-safe). */
    readonly remove: (
        rec: SkillRecord,
    ) => Effect.Effect<void, SkillReadOnlyError | PlatformError, FileSystem.FileSystem | Path.Path>;
    /** Move the record into `<root>/.ax-parked/` (out of discovery). */
    readonly park: (
        rec: SkillRecord,
    ) => Effect.Effect<void, SkillReadOnlyError | PlatformError, FileSystem.FileSystem | Path.Path>;
    /** Move a parked record back into discovery under `ref.root`. */
    readonly unpark: (
        name: string,
        ref: SkillDirRef,
    ) => Effect.Effect<void, SkillReadOnlyError | PlatformError, FileSystem.FileSystem | Path.Path>;
}

/** Directory name a parked record is moved into (sibling of the live root). */
export const PARKED_DIRNAME = ".ax-parked";
