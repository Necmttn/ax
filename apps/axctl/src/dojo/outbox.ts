import { Effect, FileSystem, type PlatformError } from "effect";
import { classifyNoFollow } from "@ax/lib/shared/fs-classify";
import { skipNotFound } from "@ax/lib/shared/fs-error";
import { posixPath } from "@ax/lib/shared/path";
import { dojoOutboxDir } from "./paths.ts";
import { shortHash, slugify } from "./slug.ts";

export type DraftKind = "bug" | "improvement";

export interface OutboxDraft {
    readonly file: string;
    readonly title: string;
    readonly kind: string;
    readonly created_at: string;
    readonly session: string | null;
}

export interface WriteDraftInput {
    readonly title: string;
    readonly kind: DraftKind;
    readonly body: string;
    readonly session?: string | null;
    readonly nowMs: number;
    readonly outboxDir?: string;
}

const field = (content: string, key: string): string | null => {
    const m = new RegExp(`^${key}:[^\\S\\n]*(.*)$`, "m").exec(content);
    const v = m?.[1]?.trim();
    return v && v.length > 0 ? v : null;
};

/** Pure: parse a draft's frontmatter, or null when it isn't a frontmatter doc. */
export const parseDraftFrontmatter = (file: string, content: string): OutboxDraft | null => {
    if (!content.startsWith("---")) return null;
    const title = field(content, "title");
    const kind = field(content, "kind");
    const created_at = field(content, "created_at");
    if (!title || !kind || !created_at) return null;
    return { file, title, kind, created_at, session: field(content, "session") };
};

const render = (i: WriteDraftInput): string => {
    const fm = [
        "---",
        `title: ${i.title}`,
        `kind: ${i.kind}`,
        `created_at: ${new Date(i.nowMs).toISOString()}`,
        ...(i.session ? [`session: ${i.session}`] : []),
        "---",
        "",
    ].join("\n");
    return `${fm}${i.body}\n`;
};

export const writeDraft = (
    input: WriteDraftInput,
): Effect.Effect<{ path: string; slug: string }, PlatformError.PlatformError, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = input.outboxDir ?? dojoOutboxDir();
        yield* fs.makeDirectory(dir, { recursive: true });
        const slug = slugify(input.title);
        const name = `${slug}-${shortHash(input.title)}.md`;
        const path = posixPath.join(dir, name);
        const tmp = `${path}.tmp.${process.pid}`;
        yield* fs.writeFileString(tmp, render(input));
        yield* fs.rename(tmp, path);
        return { path, slug };
    });

export const listDrafts = (
    outboxDir: string = dojoOutboxDir(),
): Effect.Effect<OutboxDraft[], PlatformError.PlatformError, FileSystem.FileSystem> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const exists = yield* fs.exists(outboxDir).pipe(Effect.orElseSucceed(() => false));
        if (!exists) return [];
        const names = yield* fs.readDirectory(outboxDir).pipe(Effect.orElseSucceed(() => [] as string[]));
        const drafts: OutboxDraft[] = [];
        for (const name of names) {
            if (!name.endsWith(".md")) continue;
            const full = posixPath.join(outboxDir, name);
            const kind = yield* classifyNoFollow(full);
            if (kind !== "File") continue;
            const content = yield* fs.readFileString(full).pipe(skipNotFound(null));
            if (content === null) continue;
            const draft = parseDraftFrontmatter(name, content);
            if (draft) drafts.push(draft);
        }
        return drafts.sort((a, b) => a.created_at.localeCompare(b.created_at));
    });
