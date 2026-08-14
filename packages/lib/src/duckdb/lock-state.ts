/**
 * Pure lock-file reasoning: what the file says, and what to do about it.
 * Kept away from the filesystem so every branch (live holder, dead holder,
 * corrupt file, our own leftover) is testable without spawning a process.
 */
export interface LockPayload {
    readonly pid: number;
    readonly started_at: string;
    /**
     * A random per-ACQUIRE token (cross-review P1-4). `pid` alone cannot tell
     * one of this process's acquires from the next, so a late release of an
     * already-released handle used to delete whatever this process had
     * acquired SINCE. `release` compares the bytes it wrote - token included -
     * against what is on disk, and removes the file only on an exact match.
     * Optional so a payload written by an older build still decodes.
     */
    readonly token?: string;
    /**
     * The HOLDER PROCESS's start time, as reported by `ps -o lstart=`
     * (cross-review P2-3). A pid is reused freely by the OS, so "the pid is
     * alive" is not "the holder is alive"; a live pid whose start time no
     * longer matches this value is a corpse. Best-effort - absent when `ps`
     * is unavailable, in which case liveness falls back to the pid probe
     * alone.
     */
    readonly proc_started_at?: string;
}

export const encodeLockPayload = (payload: LockPayload): string =>
    `${JSON.stringify(payload)}\n`;

/** An optional string field: present-and-non-empty, or absent. Anything else
 *  (a number, an empty string, null) makes the whole payload corrupt rather
 *  than silently dropping the field. */
const optionalText = (value: unknown): { readonly ok: true; readonly value: string | undefined } | { readonly ok: false } => {
    if (value === undefined) return { ok: true, value: undefined };
    if (typeof value === "string" && value.length > 0) return { ok: true, value };
    return { ok: false };
};

export const decodeLockPayload = (text: string): LockPayload | null => {
    try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== "object" || parsed === null) return null;
        const { pid, started_at, token, proc_started_at } = parsed as Record<string, unknown>;
        if (typeof pid !== "number" || !Number.isInteger(pid)) return null;
        // Cross-review P3-5: pid 0 and negative pids are not process ids, and
        // they are not harmless either - `process.kill(0, 0)` signals the
        // CALLER'S OWN process group and succeeds, so a corrupt `"pid": 0`
        // read back as a LIVE holder and wedged the lock permanently. Corrupt
        // input must decode as corrupt (`null` -> `stale`), never as a holder.
        if (pid <= 0) return null;
        if (typeof started_at !== "string" || started_at.length === 0) return null;
        const decodedToken = optionalText(token);
        if (!decodedToken.ok) return null;
        const decodedStart = optionalText(proc_started_at);
        if (!decodedStart.ok) return null;
        return {
            pid,
            started_at,
            ...(decodedToken.value === undefined ? {} : { token: decodedToken.value }),
            ...(decodedStart.value === undefined ? {} : { proc_started_at: decodedStart.value }),
        };
    } catch {
        return null;
    }
};

export interface LockDecision {
    readonly kind: "free" | "held" | "stale";
    readonly holder?: LockPayload;
}

/**
 * `stale` covers three cases that all mean "take it": the holder process is
 * gone, the file is unparseable, or the pid is US but we are NOT currently
 * holding it in THIS process (`selfHolds`) - a leftover from a pid our OS
 * happened to reuse, or a leftover from a prior run of this same pid that
 * never released. `isAlive` alone cannot distinguish that leftover case from
 * a genuine second in-process acquirer, because our own pid is by definition
 * always alive - hence `selfHolds`, which the caller tracks per-process (see
 * `lock.ts`), not derived from anything on disk.
 *
 * `isAlive` is "is the RECORDED HOLDER still running", not merely "does this
 * pid exist": `lock.ts` passes a probe that also compares the payload's
 * `proc_started_at` fingerprint when there is one, so a REUSED pid answers
 * false here (cross-review P2-3). This module stays pure and knows nothing
 * about how that is measured.
 *
 * When the pid IS ours and `selfHolds` is true, the file names a lock we
 * ourselves currently hold open - that is `held`, not `stale`, so a second
 * concurrent `acquire()` call in the same process (e.g. two in-process
 * ingest requests) is correctly rejected instead of clobbering the first.
 */
export const decideLock = (
    text: string | null,
    isAlive: (pid: number) => boolean,
    selfPid: number,
    selfHolds: boolean,
): LockDecision => {
    if (text === null) return { kind: "free" };
    const holder = decodeLockPayload(text);
    if (holder === null) return { kind: "stale" };
    if (holder.pid === selfPid) return { kind: selfHolds ? "held" : "stale", holder };
    return isAlive(holder.pid) ? { kind: "held", holder } : { kind: "stale", holder };
};
