import { afterEach, describe, expect } from "bun:test";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("retro meta pipe", { requireFts: true });
const CLI = Bun.fileURLToPath(new URL("./index.ts", import.meta.url));

describe("retro meta through a real pipe", () => {
    // Detached groups do not receive terminal Ctrl-C. The test timeout bounds their lifetime.
    const children = new Set<Bun.Subprocess>();
    afterEach(async () => {
        for (const child of children) {
            if (child.exitCode === null) {
                try { process.kill(-child.pid, "SIGKILL"); }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
            }
        }
        await Promise.allSettled([...children].map((child) => child.exited));
        children.clear();
    });
    dtest("waits for a delayed reader to receive the complete JSON snapshot", async () => {
        const dir = tempDir("ax-retro-meta-pipe-");
        const description = "管道🙂".repeat(64 * 1024);
        const fixture = await runWithPlatform(publishCacheFixture(dir, dylibPath, (write) =>
            write.put("skill", {
                id: "pipe-fixture", name: "pipe-fixture", scope: "user", description,
                dir_path: dir, content_hash: "fixture",
            }),
        ));
        const args = ["bun", CLI, "retro", "meta", "--since=7", "--limit-retros=8"];
        const env = {
            ...process.env,
            AX_DUCKDB_SNAPSHOT: fixture.snapshotPath,
            AX_SIDECAR_PATH: `${dir}/judgment.sqlite`,
            AX_NO_AUTO_INGEST: "1",
            AX_PROGRESS: "off",
            NO_COLOR: "1",
        };
        // Direct file output is the known-complete reference for the same CLI.
        const referenceFile = Bun.file(`${dir}/reference.json`);
        const referenceStarted = performance.now();
        const reference = Bun.spawn(args, { env, stdout: referenceFile, stderr: "pipe", detached: true });
        children.add(reference);
        const referenceStderr = await new Response(reference.stderr).text();
        expect(await reference.exited, referenceStderr).toBe(0);
        const readerDelayMs = Math.ceil((performance.now() - referenceStarted) * 2 + 1000);
        const referenceText = await referenceFile.text();
        expect(JSON.parse(referenceText).current_state.skills[0].description === description).toBe(true);
        // A separate process leaves the OS pipe unread until the CLI finishes
        // its query. A delayed Web Stream reader in this process can prefetch
        // bytes and mask backpressure, so it is not a sufficient regression.
        const consumer = `
await Bun.sleep(${readerDelayMs});
const text = await new Response(Bun.stdin.stream()).text();
let description = null;
try { description = JSON.parse(text).current_state.skills[0].description; } catch {}
console.log(JSON.stringify({ bytes: Buffer.byteLength(text), digest: description === null ? null : new Bun.CryptoHasher("sha256").update(description).digest("hex") }));
`;
        const child = Bun.spawn([
            "bash", "-o", "pipefail", "-c", '"$@" | bun -e "$AX_PIPE_CONSUMER"',
            "ax-retro-meta-pipe", ...args,
        ], {
            env: {
                ...env,
                AX_PIPE_CONSUMER: consumer,
            },
            stdout: "pipe",
            stderr: "pipe",
            detached: true,
        });
        children.add(child);
        const [stdout, stderr, exitCode] = await Promise.all([
            new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        expect(exitCode, stderr).toBe(0);
        const result = JSON.parse(stdout) as { bytes: number; digest: string | null };
        expect(result.bytes).toBe(Buffer.byteLength(referenceText));
        // Keep failures small: do not print the synthetic 640 KiB payload.
        const digest = new Bun.CryptoHasher("sha256").update(description).digest("hex");
        expect(result.digest, `received ${result.bytes} bytes`).toBe(digest);
    }, 60_000);
});
