import { Effect, FileSystem, type PlatformError } from "effect";
import { classifyNoFollow } from "@ax/lib/shared/fs-classify";
import { orAbsent, skipNotFound } from "@ax/lib/shared/fs-error";
import { posixPath } from "@ax/lib/shared/path";
import type { DojoItem } from "./schema.ts";

const FILLED_PRIMARY_ROLE = /^primary_role:[^\S\n]*\S/m;

/** Pure: filename + content -> open agenda item, or null when nothing to do. */
export const classifyBriefFile = (name: string, content: string): DojoItem | null => {
    if (!name.endsWith(".md")) return null;
    if (name.startsWith("classify-")) {
        if (FILLED_PRIMARY_ROLE.test(content)) return null; // filled, skills lint will sweep it
        return {
            id: `brief:${name}`,
            kind: "brief_unfilled",
            title: `Fill skills-classify brief ${name}`,
            commands: [
                `$EDITOR .ax/tasks/${name}  # fill primary_role + rationale`,
                "ax skills lint",
            ],
            success: "brief consumed by ax skills lint (file deleted, plays_role edges written)",
            cost_class: "s",
        };
    }
    if (name.startsWith("routing-tune-")) {
        return {
            id: `brief:${name}`,
            kind: "routing_backtest",
            title: `Backtest + apply routing-tune brief ${name}`,
            commands: [
                `$EDITOR .ax/tasks/${name}  # review judgment-flagged classes, backtest vs history`,
                // v0 limitation: --days=30 is a static default; once brief content is
                // parsed, this should carry the brief's own --days window instead.
                "ax routing tune --apply=<ids from brief> --days=30",
            ],
            success: "selected classes applied to ~/.ax/hooks/routing-table.json; brief resolved",
            cost_class: "m",
        };
    }
    return {
        id: `brief:${name}`,
        kind: "brief_unfilled",
        title: `Act on improve brief ${name}`,
        commands: [
            `$EDITOR .ax/tasks/${name}  # act on the brief in the target files`,
            "ax improve lint",
        ],
        success: "marker landed in target file; ax improve lint deletes the brief",
        cost_class: "m",
    };
};

/**
 * Effect glue: scan the task dir (AX_TASK_DIR ?? $PWD/.ax/tasks) into items.
 *
 * Discovery probes (exists/readDirectory) use `orAbsent` - a missing or
 * unreadable dir means "no open briefs". Each entry is classified first
 * (`classifyNoFollow`, the house pattern from ingest) and non-files
 * (subdirectories, symlinks) are skipped - readFileString on a directory
 * raises BadResource and would otherwise kill the whole source. The per-file
 * content read uses `skipNotFound(null)` + skip-on-null: a brief that
 * vanished mid-scan is SKIPPED (never classified from an empty string into a
 * spurious unfilled item); any other read fault (permission, IO) re-raises so
 * real data is never silently dropped.
 */
export const scanTaskDir = (
    taskDir: string,
): Effect.Effect<DojoItem[], PlatformError.PlatformError, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        if (!(yield* fs.exists(taskDir).pipe(orAbsent(false)))) return [];
        const names = yield* fs.readDirectory(taskDir).pipe(orAbsent([] as string[]));
        const items: DojoItem[] = [];
        for (const name of names) {
            const path = posixPath.join(taskDir, name);
            const kind = yield* classifyNoFollow(path);
            if (kind !== "File") continue; // subdir/symlink/etc - not a brief
            const content = yield* fs.readFileString(path).pipe(skipNotFound(null));
            if (content === null) continue; // vanished mid-scan - skip, don't misclassify
            const item = classifyBriefFile(name, content);
            if (item) items.push(item);
        }
        return items;
    });

export const defaultTaskDir = (): string =>
    process.env.AX_TASK_DIR ?? posixPath.join(process.cwd(), ".ax", "tasks");
