/**
 * Atomic JSON file write shared across profile state files
 * (publish-state, highlights). Write to a sibling pid-tmp file then `mv` into
 * place - same-directory rename is atomic on POSIX, so a reader never sees a
 * partial file. `node:fs` is banned by the check:no-node-fs CI gate, so the
 * rename/cleanup steps shell out via Bun.spawnSync(["mv"|"rm", ...]).
 */
export async function atomicWriteJson(path: string, data: unknown): Promise<void> {
    const tmp = `${path}.${process.pid}.tmp`;
    await Bun.write(tmp, `${JSON.stringify(data, null, 2)}\n`, { createPath: true });
    const result = Bun.spawnSync(["mv", tmp, path]);
    if (result.exitCode !== 0) {
        Bun.spawnSync(["rm", "-f", tmp]);
        throw new Error(`atomicWriteJson: mv ${tmp} → ${path} failed (exit ${result.exitCode})`);
    }
}
