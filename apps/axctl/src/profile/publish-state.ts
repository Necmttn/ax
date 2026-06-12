/**
 * Local publish state: consent + gist pointer + freshness. One JSON at
 * ~/.ax/profile-publish.json. Deleting the file revokes consent (the
 * watcher step no-ops without it). Reads never throw - any corruption
 * degrades to "not published yet".
 *
 * Atomic write: Bun.write(tmp) + mv rename keeps the reader from ever
 * seeing a partial file. node:fs is banned by CI gate check:no-node-fs,
 * so we use Bun.spawnSync(["mv", ...]) for the rename step.
 */

export interface PublishState {
    readonly v: 1;
    readonly gist_id: string;
    readonly owner: string;
    readonly consented_at: string;
    readonly published_at: string;
    readonly no_cost: boolean;
}

export const defaultPublishStatePath = (): string =>
    `${process.env.HOME}/.ax/profile-publish.json`;

export async function loadPublishState(path: string): Promise<PublishState | null> {
    try {
        const file = Bun.file(path);
        if (!(await file.exists())) return null;
        const raw: unknown = JSON.parse(await file.text());
        if (typeof raw !== "object" || raw === null) return null;
        const r = raw as Record<string, unknown>;
        if (
            r.v !== 1 ||
            typeof r.gist_id !== "string" ||
            typeof r.owner !== "string" ||
            typeof r.consented_at !== "string" ||
            typeof r.published_at !== "string" ||
            typeof r.no_cost !== "boolean"
        ) {
            return null;
        }
        return {
            v: 1,
            gist_id: r.gist_id,
            owner: r.owner,
            consented_at: r.consented_at,
            published_at: r.published_at,
            no_cost: r.no_cost,
        };
    } catch {
        return null;
    }
}

export async function savePublishState(path: string, state: PublishState): Promise<void> {
    // Atomic: write to a sibling tmp file, then rename into place.
    // Same-directory rename is atomic on POSIX. node:fs is banned by the
    // check:no-node-fs CI gate, so we use Bun.spawnSync(["mv", ...]).
    const tmp = `${path}.${process.pid}.tmp`;
    await Bun.write(tmp, `${JSON.stringify(state, null, 2)}\n`, { createPath: true });
    const result = Bun.spawnSync(["mv", tmp, path]);
    if (result.exitCode !== 0) {
        // Clean up the tmp file and surface the error
        Bun.spawnSync(["rm", "-f", tmp]);
        throw new Error(
            `savePublishState: mv ${tmp} → ${path} failed (exit ${result.exitCode})`,
        );
    }
}
