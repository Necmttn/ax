/**
 * Local publish state: consent + gist pointer + freshness. One JSON at
 * ~/.ax/profile-publish.json. Deleting the file revokes consent (the
 * watcher step no-ops without it). Reads never throw - any corruption
 * degrades to "not published yet".
 *
 * Atomic write via the shared atomicWriteJson helper (Bun.write tmp + mv).
 */
import { atomicWriteJson } from "./fs.ts";

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
    await atomicWriteJson(path, state);
}
