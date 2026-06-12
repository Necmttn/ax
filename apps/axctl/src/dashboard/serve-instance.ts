/**
 * "Which ax serve instance is running?" - the pidfile next to runtime.json,
 * the /api/version port probe, and pid helpers. Everything here is plain
 * async (no Effect runtime) because it runs on the serve startup path and in
 * the flag-free `ax serve status|stop` subcommands, both of which route
 * through `withoutDb`.
 */
import { homedir } from "node:os";
import { posixPath } from "@ax/lib/shared/path";

export interface ServePidfile {
    readonly version: 1;
    readonly pid: number;
    readonly port: number;
    readonly startedAt: string;
    readonly axVersion: string;
}

export function servePidfilePath(
    dataDir = process.env.AX_DATA_DIR ??
        posixPath.join(homedir(), ".local", "share", "ax"),
): string {
    return posixPath.join(dataDir, "serve.json");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Read the pidfile, tolerating absence and any unrecognised shape - callers
 * treat `null` as "no managed instance recorded" and fall back to probing.
 */
export async function readServePidfile(
    path = servePidfilePath(),
): Promise<ServePidfile | null> {
    let raw: string;
    try {
        raw = await Bun.file(path).text();
    } catch {
        return null;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!isRecord(parsed)) return null;
    const { pid, port, startedAt, axVersion } = parsed;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
    if (typeof port !== "number" || !Number.isInteger(port) || port <= 0) return null;
    return {
        version: 1,
        pid,
        port,
        startedAt: typeof startedAt === "string" ? startedAt : new Date(0).toISOString(),
        axVersion: typeof axVersion === "string" ? axVersion : "unknown",
    };
}

/**
 * Record this process as the running instance. `Bun.write` creates parent
 * directories; the write is not atomic, but the file is written once per
 * server start and the reader tolerates garbage, so a torn read degrades to
 * the probe fallback rather than a crash.
 */
export async function writeServePidfile(
    state: Omit<ServePidfile, "version">,
    path = servePidfilePath(),
): Promise<void> {
    await Bun.write(path, `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`);
}

export async function removeServePidfile(path = servePidfilePath()): Promise<void> {
    await Bun.file(path).delete().catch(() => undefined);
}

/** Signal-0 liveness check; EPERM (signal denied) still means alive. */
export function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return isRecord(err) && (err as { code?: string }).code === "EPERM";
    }
}

/**
 * Resolve the pid LISTENing on a local TCP port via lsof (macOS + linux).
 * Returns null when lsof is missing, fails, or finds nothing - callers fall
 * back to printing the manual lsof hint.
 */
export async function findListenerPid(port: number): Promise<number | null> {
    try {
        const proc = Bun.spawn(["lsof", "-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
            stdout: "pipe",
            stderr: "ignore",
        });
        const out = await new Response(proc.stdout).text();
        await proc.exited;
        const pid = Number.parseInt(out.trim().split("\n")[0] ?? "", 10);
        return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
        return null;
    }
}

export type ServeProbe =
    | { readonly kind: "ax"; readonly version: string; readonly liveIngest: boolean }
    | { readonly kind: "foreign" }
    | { readonly kind: "none" };

/**
 * Ask whoever holds the port to identify itself. An ax daemon answers
 * /api/version with `{ version, api_version, ... }`; any other HTTP listener
 * is "foreign"; no/hung response is "none" (closed port, or a non-HTTP
 * listener - the Bun.serve EADDRINUSE path catches that case).
 */
export async function probeServePort(
    port: number,
    timeoutMs = 1500,
): Promise<ServeProbe> {
    let res: Response;
    try {
        res = await fetch(`http://127.0.0.1:${port}/api/version`, {
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch {
        return { kind: "none" };
    }
    if (!res.ok) return { kind: "foreign" };
    const body: unknown = await res.json().catch(() => null);
    if (
        isRecord(body) &&
        typeof body.version === "string" &&
        "api_version" in body
    ) {
        return { kind: "ax", version: body.version, liveIngest: body.live_ingest === true };
    }
    return { kind: "foreign" };
}

/** Narrow an unknown throw to the listen-failure we handle specially. */
export function isAddrInUse(err: unknown): boolean {
    return isRecord(err) && (err as { code?: string }).code === "EADDRINUSE";
}
