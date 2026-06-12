/**
 * On-disk quota cache: one JSON snapshot at ~/.ax/quota-cache.json. The
 * statusline integration fires `ax quota --statusline` every render tick, so
 * reads must be cheap and the endpoint must not be hammered - the cache TTL
 * (default 60s) bounds the poll rate regardless of caller cadence. Reads
 * never throw; corruption degrades to "no cache". Atomic write mirrors
 * profile/publish-state.ts (Bun.write tmp + mv; node:fs is banned by the
 * check:no-node-fs CI gate).
 */
import { decodeQuotaSnapshot, type QuotaSnapshot } from "./schema.ts";
import { decodeJsonOrNull } from "@ax/lib/decode";

export const defaultQuotaCachePath = (): string =>
    `${process.env.HOME}/.ax/quota-cache.json`;

export async function loadQuotaCache(path: string): Promise<QuotaSnapshot | null> {
    try {
        const file = Bun.file(path);
        if (!(await file.exists())) return null;
        return decodeQuotaSnapshot(decodeJsonOrNull(await file.text()));
    } catch {
        return null;
    }
}

export async function saveQuotaCache(path: string, snapshot: QuotaSnapshot): Promise<void> {
    const tmp = `${path}.${process.pid}.tmp`;
    await Bun.write(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, { createPath: true });
    const result = Bun.spawnSync(["mv", tmp, path]);
    if (result.exitCode !== 0) {
        Bun.spawnSync(["rm", "-f", tmp]);
        throw new Error(`saveQuotaCache: mv ${tmp} -> ${path} failed (exit ${result.exitCode})`);
    }
}

/** Snapshot age check; a malformed fetched_at counts as stale. */
export const isFresh = (
    snapshot: QuotaSnapshot,
    nowMs: number,
    maxAgeSeconds: number,
): boolean => {
    const fetchedMs = Date.parse(snapshot.fetched_at);
    if (!Number.isFinite(fetchedMs)) return false;
    return nowMs - fetchedMs < maxAgeSeconds * 1000;
};
