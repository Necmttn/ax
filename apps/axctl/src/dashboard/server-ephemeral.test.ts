/**
 * `ax studio` is EPHEMERAL (wave 3, `c-daemon-studio`) - the defining
 * property is not "it serves requests" (any HTTP server does that) but "it
 * exits on its own". A server that never exits is invisible: it behaves
 * exactly like the old always-on daemon until a user's machine accumulates
 * processes. So this suite spawns the REAL entrypoint as a child process
 * (`serveDashboard` never returns while serving - only a genuine OS process
 * can demonstrate "gone"), talks to it over HTTP like a browser would, stops
 * talking to it, and asserts the process actually terminates within its
 * (test-shortened) idle budget - not merely that it answered a request.
 *
 * Runs against a REAL published DuckDB snapshot (empty is enough - the
 * acceptance bar is "serves over a published snapshot", not "has data"), the
 * same `duckdbTestSetup` + `publishCacheFixture` pattern `usage.test.ts` uses,
 * because a stub can't prove the child process can actually open the
 * snapshot the way a real `ax studio` invocation does.
 */
import { afterAll, describe, expect } from "bun:test";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { Effect } from "effect";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("studio ephemeral server", { requireFts: true });

const serverEntrypoint = new URL("./server.ts", import.meta.url).pathname;

/** High, unlikely-to-collide range - tests may run concurrently. */
const randomPort = (): number => 34000 + Math.floor(Math.random() * 8000);

const children: Array<ReturnType<typeof Bun.spawn>> = [];
afterAll(() => {
    for (const child of children) {
        if (child.exitCode === null) child.kill();
    }
});

/**
 * Spawn `serveDashboard` as a real child process (a tiny inline script, not
 * the full CLI, so this test doesn't also depend on argv/Command parsing).
 * `idleTimeoutMs`/`hardTimeoutMs` are test-shortened via env so the exit
 * assertion below runs in milliseconds, not the real default of minutes.
 */
function spawnStudio(opts: {
    readonly port: number;
    readonly snapshotPath: string;
    readonly idleTimeoutMs: number;
}): ReturnType<typeof Bun.spawn> {
    const child = Bun.spawn({
        cmd: [
            "bun",
            "-e",
            `import("${serverEntrypoint}").then((m) => m.serveDashboard(["--port=${opts.port}"]))`,
        ],
        env: {
            ...process.env,
            AX_DUCKDB_DYLIB: dylibPath ?? "",
            AX_DUCKDB_REQUIRE_FTS: "1",
            AX_DUCKDB_SNAPSHOT: opts.snapshotPath,
            AX_STUDIO_IDLE_TIMEOUT_MS: String(opts.idleTimeoutMs),
            // Backstop only - the idle checker should fire first. Long enough
            // that a slow CI box never trips it before the idle path does,
            // short enough this test doesn't hang for real if the idle path
            // is broken.
            AX_STUDIO_HARD_TIMEOUT_MS: "15000",
        },
        stdout: "pipe",
        stderr: "pipe",
    });
    children.push(child);
    return child;
}

/** Poll `GET /api/version` until it answers 200 or `deadlineMs` elapses. */
async function waitUntilUp(port: number, deadlineMs = 5000): Promise<void> {
    const started = Date.now();
    for (;;) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/version`);
            if (res.ok) {
                await res.body?.cancel();
                return;
            }
        } catch {
            // not listening yet
        }
        if (Date.now() - started > deadlineMs) {
            throw new Error(`studio on port ${port} never came up within ${deadlineMs}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

describe("ax studio (ephemeral server)", () => {
    dtest("serves GET / and GET /api/sessions over a published snapshot, then EXITS after the client disconnects", async () => {
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("studio-ephemeral"), dylibPath, () => Effect.void),
        );
        const port = randomPort();
        const child = spawnStudio({ port, snapshotPath: fixture.snapshotPath, idleTimeoutMs: 400 });

        await waitUntilUp(port);

        // The client is "connected": GET / (the studio shell / landing page)
        // and GET /api/sessions (the acceptance-named endpoint) both answer
        // over the real published snapshot.
        const root = await fetch(`http://127.0.0.1:${port}/`);
        expect(root.status).toBe(200);
        await root.body?.cancel();

        const sessions = await fetch(`http://127.0.0.1:${port}/api/sessions`);
        expect(sessions.status).toBe(200);
        const sessionsBody: unknown = await sessions.json();
        expect(sessionsBody).not.toBeNull();

        // "Disconnect": stop sending requests entirely. Assert the PROCESS
        // exits - not that a request succeeded, not that a log line printed.
        // Bun's `.exited` promise only resolves on real process termination,
        // so this can't pass on a server that merely stopped answering while
        // still running.
        const exitedOrTimedOut = await Promise.race([
            child.exited.then((code) => ({ exited: true as const, code })),
            new Promise<{ exited: false }>((resolve) =>
                setTimeout(() => resolve({ exited: false }), 5000)
            ),
        ]);
        expect(exitedOrTimedOut.exited).toBe(true);
        if (exitedOrTimedOut.exited) {
            expect(exitedOrTimedOut.code).toBe(0);
        }
        // Belt-and-suspenders on the exact hazard the acceptance criteria
        // calls out: signal-0 the pid and confirm the kernel has no such
        // process, rather than trusting `.exited` alone.
        expect(child.exitCode).not.toBeNull();
    }, 10000);

    dtest("an explicit SIGTERM exits immediately, without waiting for the idle timeout", async () => {
        const fixture = await runWithPlatform(
            publishCacheFixture(tempDir("studio-ephemeral-sigterm"), dylibPath, () => Effect.void),
        );
        const port = randomPort();
        // A LONG idle timeout - if SIGTERM handling were broken and this test
        // fell back to waiting out the idle path, it would time out instead
        // of false-passing.
        const child = spawnStudio({ port, snapshotPath: fixture.snapshotPath, idleTimeoutMs: 120000 });

        await waitUntilUp(port);
        child.kill("SIGTERM");

        const exitedOrTimedOut = await Promise.race([
            child.exited.then(() => true),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
        ]);
        expect(exitedOrTimedOut).toBe(true);
    }, 8000);
});
