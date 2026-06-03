/**
 * Skill SOURCE access for the dashboard: read a skill's SKILL.md (frontmatter
 * + body), reflect a triage decision onto disk, and open the file in the OS
 * file manager or an editor.
 *
 * The dashboard server is always local, so reading/renaming skill files and
 * spawning a viewer are safe. Disk writes are restricted to user-owned skill
 * scopes - plugin/builtin/codex skills are read-only because rewriting them
 * would fight the plugin manager or has no real file at all.
 */
import { spawn } from "node:child_process";
import { Effect, FileSystem } from "effect";
import { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { orAbsent } from "@ax/lib/shared/fs-error";
import { posixPath } from "@ax/lib/shared/path";
import { surrealLiteral } from "@ax/lib/json";
import type {
    SkillSourcePayload,
    SkillSourceState,
    TriageDecision,
} from "@ax/lib/shared/dashboard-types";

const SKILL_FILE = "SKILL.md";
const ARCHIVED_FILE = "SKILL.md.archived";

/** Scopes ax may rewrite on disk - the user's own skill roots (see
 *  `defaultSkillDirs` in lib/paths.ts). Everything else is read-only. */
const EDITABLE_SCOPES = new Set(["user", "agents-shared"]);

const isEditableScope = (scope: string): boolean => EDITABLE_SCOPES.has(scope);

/** GUI editors safe to launch detached from the server process. Terminal
 *  editors (vim, nano) are useless spawned headless, so they fall through to
 *  the OS default handler instead. */
const GUI_EDITORS = new Set([
    "code",
    "code-insiders",
    "cursor",
    "subl",
    "zed",
    "windsurf",
]);

const fileExists = (path: string): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // Original probed via `access` in a try/catch: any failure -> absent.
        return yield* fs.exists(path).pipe(orAbsent(false));
    });

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

const splitFrontmatter = (
    text: string,
): { frontmatter: string | null; body: string } => {
    const m = text.match(FRONTMATTER_RE);
    if (!m) return { frontmatter: null, body: text };
    return { frontmatter: (m[1] ?? "").trim(), body: (m[2] ?? "").replace(/^\s+/, "") };
};

interface DiskRead {
    readonly state: SkillSourceState;
    readonly file_path: string | null;
    readonly frontmatter: string | null;
    readonly body: string | null;
    readonly error: string | null;
}

const readSkillFromDir = (
    dirPath: string,
): Effect.Effect<DiskRead, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const activePath = posixPath.join(dirPath, SKILL_FILE);
        const archivedPath = posixPath.join(dirPath, ARCHIVED_FILE);
        const [hasActive, hasArchived] = yield* Effect.all([
            fileExists(activePath),
            fileExists(archivedPath),
        ]);
        const target = hasActive ? activePath : hasArchived ? archivedPath : null;
        if (!target) {
            return { state: "missing", file_path: null, frontmatter: null, body: null, error: null };
        }
        const state: SkillSourceState = hasActive ? "active" : "disabled";
        // Original caught ANY read failure and surfaced it as an error string.
        return yield* fs.readFileString(target).pipe(
            Effect.map((text): DiskRead => {
                const { frontmatter, body } = splitFrontmatter(text);
                return { state, file_path: target, frontmatter, body, error: null };
            }),
            Effect.catchTag("PlatformError", (err) =>
                Effect.succeed<DiskRead>({
                    state,
                    file_path: target,
                    frontmatter: null,
                    body: null,
                    error: err.message,
                }),
            ),
        );
    });

interface SkillRowMeta {
    readonly scope: string;
    readonly dir_path: string | null;
}

const fetchSkillMeta = (
    name: string,
): Effect.Effect<SkillRowMeta | null, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        const result = yield* db.query<[Array<Record<string, unknown>>]>(
            `SELECT scope, dir_path FROM skill WHERE name = ${surrealLiteral(name)} LIMIT 1;`,
        );
        const row = result?.[0]?.[0];
        if (!row) return null;
        const dir = row.dir_path;
        return {
            scope: typeof row.scope === "string" && row.scope.length > 0 ? row.scope : "unknown",
            dir_path: typeof dir === "string" && dir.length > 0 ? dir : null,
        };
    });

const isSyntheticDir = (dirPath: string | null): boolean =>
    dirPath === null || dirPath === "(synthetic)";

/** Read a skill's SKILL.md content + on-disk state. Synthetic skills (codex
 *  tools, claude builtins) come back `missing` / non-editable. */
export const readSkillSource = (
    name: string,
): Effect.Effect<SkillSourcePayload, DbError, SurrealClient | FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const meta = yield* fetchSkillMeta(name);
        const scope = meta?.scope ?? "unknown";
        const dirPath = meta?.dir_path ?? null;
        if (isSyntheticDir(dirPath)) {
            return {
                name,
                scope,
                dir_path: dirPath,
                file_path: null,
                frontmatter: null,
                body: null,
                state: "missing" as SkillSourceState,
                editable: false,
                error: meta ? null : `no skill named "${name}"`,
            };
        }
        const disk = yield* readSkillFromDir(dirPath as string);
        return {
            name,
            scope,
            dir_path: dirPath,
            file_path: disk.file_path,
            frontmatter: disk.frontmatter,
            body: disk.body,
            state: disk.state,
            editable: isEditableScope(scope) && disk.state !== "missing",
            error: disk.error,
        };
    });

/** Rename SKILL.md <-> SKILL.md.archived so the on-disk state matches `want`.
 *  Idempotent: returns the resulting state without erroring when already there. */
export const setSkillDiskState = (
    dirPath: string,
    want: "active" | "disabled",
): Effect.Effect<SkillSourceState, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const activePath = posixPath.join(dirPath, SKILL_FILE);
        const archivedPath = posixPath.join(dirPath, ARCHIVED_FILE);
        const [hasActive, hasArchived] = yield* Effect.all([
            fileExists(activePath),
            fileExists(archivedPath),
        ]);
        // Original `rename` had no tolerance (the async fn rejected, and the
        // `Effect.promise` caller died); keep dying on a rename failure.
        if (want === "disabled") {
            if (hasActive) {
                yield* fs.rename(activePath, archivedPath).pipe(Effect.orDie);
                return "disabled";
            }
            return hasArchived ? "disabled" : "missing";
        }
        if (hasArchived && !hasActive) {
            yield* fs.rename(archivedPath, activePath).pipe(Effect.orDie);
            return "active";
        }
        return hasActive ? "active" : "missing";
    });

/**
 * Reflect a triage decision onto disk for user-owned skills:
 *  - `archive` disables the skill (SKILL.md -> SKILL.md.archived) so the agent
 *    harness stops loading it.
 *  - `keep` / `review` / cleared (`null`) restores it.
 * No-op (returns `null`) for non-editable scopes and synthetic skills.
 */
export const applySkillDecisionToDisk = (
    name: string,
    decision: TriageDecision | null,
): Effect.Effect<SkillSourceState | null, DbError, SurrealClient | FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const meta = yield* fetchSkillMeta(name);
        if (!meta || isSyntheticDir(meta.dir_path) || !isEditableScope(meta.scope)) {
            return null;
        }
        const want: "active" | "disabled" = decision === "archive" ? "disabled" : "active";
        return yield* setSkillDiskState(meta.dir_path as string, want);
    });

const launchViewer = async (
    path: string,
    target: "finder" | "editor",
): Promise<string> => {
    const isMac = process.platform === "darwin";
    let cmd: string;
    let args: string[];
    if (target === "finder") {
        if (isMac) {
            cmd = "open";
            args = ["-R", path];
        } else {
            cmd = "xdg-open";
            args = [posixPath.dirname(path)];
        }
    } else {
        const editor = (process.env.VISUAL ?? process.env.EDITOR ?? "").trim();
        const parts = editor.split(/\s+/).filter(Boolean);
        const base = parts[0]?.split("/").pop() ?? "";
        if (parts.length > 0 && GUI_EDITORS.has(base)) {
            cmd = parts[0] as string;
            args = [...parts.slice(1), path];
        } else if (isMac) {
            cmd = "open";
            args = [path];
        } else {
            cmd = "xdg-open";
            args = [path];
        }
    }
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.unref();
    return `${cmd} ${args.join(" ")}`;
};

/** Open the skill's SKILL.md in the OS file manager (`finder`) or an editor
 *  (`editor`). Returns the command that was launched. */
export const openSkillTarget = (
    name: string,
    target: "finder" | "editor",
): Effect.Effect<{ launched: string }, DbError, SurrealClient | FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const source = yield* readSkillSource(name);
        const path = source.file_path ?? source.dir_path;
        if (!path) {
            // Surfaces as a 500 with this message via the server's try/catch.
            throw new Error(`no on-disk file for skill "${name}"`);
        }
        const launched = yield* Effect.promise(() => launchViewer(path, target));
        return { launched };
    });
