/**
 * User-authored profile highlights: load/validate/save the local
 * ~/.ax/profile-highlights.json file. The profile block (no `v`) is what
 * buildProfile attaches; the file carries `v:1`. Atomic write mirrors
 * publish-state.ts (Bun.write tmp + mv; node:fs is banned by check:no-node-fs).
 * loadHighlightsBlock is fail-open (null on missing/corrupt) like publish-state.
 */
import { Effect, Schema } from "effect";
import { Highlights } from "./schema.ts";

export const defaultHighlightsPath = (): string =>
    `${process.env.HOME}/.ax/profile-highlights.json`;

export const HighlightsFile = Schema.Struct({
    v: Schema.Literal(1),
    ...Highlights.fields,
});
export type HighlightsFile = typeof HighlightsFile.Type;

export const decodeHighlightsFile = (raw: unknown): Effect.Effect<HighlightsFile, unknown> =>
    Schema.decodeUnknownEffect(HighlightsFile)(raw);

export async function loadHighlightsBlock(path: string): Promise<Highlights | null> {
    try {
        const file = Bun.file(path);
        if (!(await file.exists())) return null;
        const raw: unknown = JSON.parse(await file.text());
        const decoded = Schema.decodeUnknownSync(HighlightsFile)(raw);
        const { v: _v, ...block } = decoded;
        return block;
    } catch {
        return null;
    }
}

export async function saveHighlightsFile(path: string, data: HighlightsFile): Promise<void> {
    const tmp = `${path}.${process.pid}.tmp`;
    await Bun.write(tmp, `${JSON.stringify(data, null, 2)}\n`, { createPath: true });
    const result = Bun.spawnSync(["mv", tmp, path]);
    if (result.exitCode !== 0) {
        Bun.spawnSync(["rm", "-f", tmp]);
        throw new Error(`saveHighlightsFile: mv ${tmp} → ${path} failed (exit ${result.exitCode})`);
    }
}
