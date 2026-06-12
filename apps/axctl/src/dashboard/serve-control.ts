/**
 * `ax serve status` / `ax serve stop` - lifecycle visibility for the local
 * daemon. Both resolve the instance from the pidfile first and fall back to
 * probing the default port, so they also handle daemons started by older
 * axctl versions that never wrote a pidfile.
 *
 * Deps are injectable so the decision logic is unit-testable without
 * sockets or live processes; defaults are the real implementations.
 */
import { DEFAULT_DASHBOARD_PORT } from "@ax/lib/dashboard-port";
import { serveStudioUrl } from "../cli/banner.ts";
import {
    findListenerPid,
    isPidAlive,
    probeServePort,
    readServePidfile,
    removeServePidfile,
    type ServePidfile,
    type ServeProbe,
} from "./serve-instance.ts";

export interface ServeControlDeps {
    readonly readPidfile: () => Promise<ServePidfile | null>;
    readonly removePidfile: () => Promise<void>;
    readonly probe: (port: number) => Promise<ServeProbe>;
    readonly pidAlive: (pid: number) => boolean;
    readonly listenerPid: (port: number) => Promise<number | null>;
    readonly kill: (pid: number, signal: NodeJS.Signals) => void;
    readonly sleep: (ms: number) => Promise<void>;
    readonly log: (line: string) => void;
    readonly error: (line: string) => void;
}

const liveDeps: ServeControlDeps = {
    readPidfile: () => readServePidfile(),
    removePidfile: () => removeServePidfile(),
    probe: (port) => probeServePort(port),
    pidAlive: isPidAlive,
    listenerPid: findListenerPid,
    kill: (pid, signal) => process.kill(pid, signal),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line) => console.log(line),
    error: (line) => console.error(line),
};

const lsofHint = (port: number): string =>
    `lsof -nP -iTCP:${port} -sTCP:LISTEN`;

/** Exit 0 when a daemon is running, 1 otherwise (systemctl-ish). */
export async function serveStatus(
    deps: ServeControlDeps = liveDeps,
): Promise<number> {
    const pidfile = await deps.readPidfile();
    const port = pidfile?.port ?? DEFAULT_DASHBOARD_PORT;
    const probe = await deps.probe(port);

    if (probe.kind === "ax") {
        const pid = pidfile !== null && deps.pidAlive(pidfile.pid)
            ? pidfile.pid
            : await deps.listenerPid(port);
        deps.log(`[ax] ax serve is running on port ${port} (${pid === null ? `pid unknown - find it: ${lsofHint(port)}` : `pid ${pid}`}, v${probe.version})`);
        if (pidfile !== null && pid === pidfile.pid) deps.log(`  started           ${pidfile.startedAt}`);
        deps.log(`  live ingest       ${probe.liveIngest ? "on" : "off (compiled binary - run from source to enable)"}`);
        deps.log(`  local daemon      http://localhost:${port}`);
        deps.log(`  open in studio    ${serveStudioUrl(port)}`);
        return 0;
    }

    if (probe.kind === "foreign") {
        deps.error(`[ax] port ${port} is in use by another process (not ax serve). See who holds it: ${lsofHint(port)}`);
        return 1;
    }

    if (pidfile !== null) {
        if (deps.pidAlive(pidfile.pid)) {
            deps.error(`[ax] pid ${pidfile.pid} from the pidfile is alive but not answering on port ${port} - the daemon may be wedged. Stop it: kill ${pidfile.pid}`);
            return 1;
        }
        await deps.removePidfile();
        deps.log(`[ax] ax serve is not running (removed stale pidfile for dead pid ${pidfile.pid}).`);
        return 1;
    }

    deps.log(`[ax] ax serve is not running. Start it: ax serve`);
    return 1;
}

/** Exit 0 when stopped or nothing was running, 1 when we refused/failed. */
export async function serveStop(
    deps: ServeControlDeps = liveDeps,
): Promise<number> {
    const pidfile = await deps.readPidfile();
    const port = pidfile?.port ?? DEFAULT_DASHBOARD_PORT;
    const probe = await deps.probe(port);

    if (probe.kind === "foreign") {
        deps.error(`[ax] port ${port} is held by another process (not ax serve) - refusing to kill it. See who holds it: ${lsofHint(port)}`);
        return 1;
    }

    if (probe.kind === "none") {
        if (pidfile !== null) {
            if (deps.pidAlive(pidfile.pid)) {
                deps.error(`[ax] pid ${pidfile.pid} from the pidfile is alive but not answering on port ${port} - not killing a process I can't identify. If it's the wedged daemon: kill ${pidfile.pid}`);
                return 1;
            }
            await deps.removePidfile();
            deps.log(`[ax] ax serve is not running (removed stale pidfile for dead pid ${pidfile.pid}).`);
            return 0;
        }
        deps.log("[ax] ax serve is not running.");
        return 0;
    }

    // An ax daemon answered. Only ever kill the pid that actually LISTENs on
    // the port - a stale pidfile pid may have been recycled by an unrelated
    // process, so the pidfile alone is never trusted as a kill target.
    const pid = await deps.listenerPid(port);
    if (pid === null) {
        deps.error(`[ax] ax serve is running on port ${port} but its pid could not be resolved (lsof unavailable?). Find it: ${lsofHint(port)}`);
        return 1;
    }

    deps.kill(pid, "SIGTERM");
    for (let waited = 0; waited < 3000 && deps.pidAlive(pid); waited += 100) {
        await deps.sleep(100);
    }
    if (deps.pidAlive(pid)) {
        deps.error(`[ax] sent SIGTERM to pid ${pid} but it is still running. Escalate manually: kill -9 ${pid}`);
        return 1;
    }
    await deps.removePidfile();
    deps.log(`[ax] stopped ax serve (pid ${pid}, port ${port}).`);
    return 0;
}
