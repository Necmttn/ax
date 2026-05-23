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
import { access, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { SurrealClient } from "../lib/db.ts";
import type { DbError } from "../lib/errors.ts";
import { surrealLiteral } from "../lib/json.ts";
import type {
    SkillSourcePayload,
    SkillSourceState,
    TriageDecision,
} from "../lib/shared/dashboard-types.ts";

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

const fileExists = async (path: string): Promise<boolean> => {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
};

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

const readSkillFromDir = async (dirPath: string): Promise<DiskRead> => {
    const activePath = join(dirPath, SKILL_FILE);
    const archivedPath = join(dirPath, ARCHIVED_FILE);
    const [hasActive, hasArchived] = await Promise.all([
        fileExists(activePath),
        fileExists(archivedPath),
    ]);
    const target = hasActive ? activePath : hasArchived ? archivedPath : null;
    if (!target) {
        return { state: "missing", file_path: null, frontmatter: null, body: null, error: null };
    }
    const state: SkillSourceState = hasActive ? "active" : "disabled";
    try {
        const text = await readFile(target, "utf8");
        const { frontmatter, body } = splitFrontmatter(text);
        return { state, file_path: target, frontmatter, body, error: null };
    } catch (err) {
        return {
            state,
            file_path: target,
            frontmatter: null,
            body: null,
            error: err instanceof Error ? err.message : String(err),
        };
    }
};

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
): Effect.Effect<SkillSourcePayload, DbError, SurrealClient> =>
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
        const disk = yield* Effect.promise(() => readSkillFromDir(dirPath as string));
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
export const setSkillDiskState = async (
    dirPath: string,
    want: "active" | "disabled",
): Promise<SkillSourceState> => {
    const activePath = join(dirPath, SKILL_FILE);
    const archivedPath = join(dirPath, ARCHIVED_FILE);
    const [hasActive, hasArchived] = await Promise.all([
        fileExists(activePath),
        fileExists(archivedPath),
    ]);
    if (want === "disabled") {
        if (hasActive) {
            await rename(activePath, archivedPath);
            return "disabled";
        }
        return hasArchived ? "disabled" : "missing";
    }
    if (hasArchived && !hasActive) {
        await rename(archivedPath, activePath);
        return "active";
    }
    return hasActive ? "active" : "missing";
};

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
): Effect.Effect<SkillSourceState | null, DbError, SurrealClient> =>
    Effect.gen(function* () {
        const meta = yield* fetchSkillMeta(name);
        if (!meta || isSyntheticDir(meta.dir_path) || !isEditableScope(meta.scope)) {
            return null;
        }
        const want: "active" | "disabled" = decision === "archive" ? "disabled" : "active";
        return yield* Effect.promise(() => setSkillDiskState(meta.dir_path as string, want));
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
            args = [dirname(path)];
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
): Effect.Effect<{ launched: string }, DbError, SurrealClient> =>
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
