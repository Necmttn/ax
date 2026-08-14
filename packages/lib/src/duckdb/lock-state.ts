/**
 * Pure lock-file reasoning: what the file says, and what to do about it.
 * Kept away from the filesystem so every branch (live holder, dead holder,
 * corrupt file, our own leftover) is testable without spawning a process.
 */
export interface LockPayload {
    readonly pid: number;
    readonly started_at: string;
}

export const encodeLockPayload = (payload: LockPayload): string =>
    `${JSON.stringify(payload)}\n`;

export const decodeLockPayload = (text: string): LockPayload | null => {
    try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== "object" || parsed === null) return null;
        const { pid, started_at } = parsed as Record<string, unknown>;
        if (typeof pid !== "number" || !Number.isInteger(pid)) return null;
        if (typeof started_at !== "string" || started_at.length === 0) return null;
        return { pid, started_at };
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
