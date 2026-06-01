import { spawnSync, type SpawnSyncReturns } from "node:child_process";

export interface PortHolder {
    readonly pid: number;
    readonly command: string;
}

export interface PortProbeResult {
    readonly port: number;
    readonly listening: boolean;
    readonly holder: PortHolder | null;
}

type LsofRunner = (port: number) => SpawnSyncReturns<string>;

const defaultLsofRunner: LsofRunner = (port) =>
    spawnSync("lsof", ["-iTCP:" + port, "-sTCP:LISTEN", "-nP", "-F", "pcL"], {
        encoding: "utf8",
    });

/**
 * Parse lsof "-F pcL" output. Each entry is a sequence of lines prefixed by a
 * single-letter tag:
 *   p<pid>
 *   c<command>
 *   L<user>     (sometimes; we ignore)
 * We only need the first matching pid+command pair.
 */
function parseLsof(stdout: string): PortHolder | null {
    let pid: number | null = null;
    let command: string | null = null;
    for (const line of stdout.split("\n")) {
        if (line.length < 2) continue;
        const tag = line[0];
        const value = line.slice(1);
        if (tag === "p") {
            const parsed = Number.parseInt(value, 10);
            if (Number.isFinite(parsed)) pid = parsed;
        } else if (tag === "c") {
            command = value;
        }
        if (pid !== null && command !== null) return { pid, command };
    }
    return null;
}

/**
 * Probe a TCP port. Returns `listening: true` plus the holder pid/command when
 * the port is bound, `listening: false` when free. Unknown systems (missing
 * lsof) report not-listening - the caller should treat that as inconclusive.
 */
export function probePort(
    port: number,
    runner: LsofRunner = defaultLsofRunner,
): PortProbeResult {
    const result = runner(port);
    if (result.status === 0 && typeof result.stdout === "string" && result.stdout.length > 0) {
        return { port, listening: true, holder: parseLsof(result.stdout) };
    }
    return { port, listening: false, holder: null };
}

export interface PortPick {
    readonly chosen: number;
    readonly attempted: ReadonlyArray<PortProbeResult>;
}

/**
 * Pick the first free port from `candidates`. Returns the probe results for
 * every port we tried so the caller can surface "conflicting process X on port
 * Y, falling back to Z". Throws when no candidate is free.
 */
export function pickFreePort(
    candidates: ReadonlyArray<number>,
    runner: LsofRunner = defaultLsofRunner,
): PortPick {
    const attempted: PortProbeResult[] = [];
    for (const port of candidates) {
        const probe = probePort(port, runner);
        attempted.push(probe);
        if (!probe.listening) return { chosen: port, attempted };
    }
    throw new Error(
        `no free port among ${candidates.join(", ")} - all are bound`,
    );
}

/** Build a candidate list starting at `preferred` with `range` consecutive ports. */
export function candidatePorts(preferred: number, range = 20): number[] {
    return Array.from({ length: range }, (_, i) => preferred + i);
}
