import { Effect, FileSystem } from "effect";
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

/** Effect glue: scan the task dir (AX_TASK_DIR ?? $PWD/.ax/tasks) into items. */
export const scanTaskDir = (
    taskDir: string,
): Effect.Effect<DojoItem[], never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const exists = yield* fs.exists(taskDir).pipe(Effect.orElseSucceed(() => false));
        if (!exists) return [];
        const names = yield* fs.readDirectory(taskDir).pipe(Effect.orElseSucceed(() => []));
        const items: DojoItem[] = [];
        for (const name of names) {
            const content = yield* fs
                .readFileString(posixPath.join(taskDir, name))
                .pipe(Effect.orElseSucceed(() => ""));
            const item = classifyBriefFile(name, content);
            if (item) items.push(item);
        }
        return items;
    });

export const defaultTaskDir = (): string =>
    process.env.AX_TASK_DIR ?? posixPath.join(process.cwd(), ".ax", "tasks");
