import { afterEach, describe, expect } from "bun:test";
import { realpathSync } from "node:fs";
import { Effect } from "effect";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { publishCacheFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("session list pipes", { requireFts: true });
const CLI = Bun.fileURLToPath(new URL("./index.ts", import.meta.url));

describe("session lists through a real pipe", () => {
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
    for (const command of ["here", "around", "near"] as const) {
        dtest(`${command} delivers all selected rows and links to a delayed reader`, async () => {
            const dir = realpathSync(tempDir(`ax-sessions-${command}-pipe-`));
            const now = new Date();
            for (const args of [
                ["init", "--quiet"],
                ["-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                    "commit", "--quiet", "--allow-empty", "-m", "fixture"],
            ]) {
                const git = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
                expect(git.exitCode, git.stderr.toString()).toBe(0);
            }
            const summary = "管道🙂".repeat(256);
            const fixture = await runWithPlatform(publishCacheFixture(dir, dylibPath, (write) =>
                Effect.gen(function* () {
                    yield* write.put("repository", { id: "pipe-repo", root_path: dir });
                    yield* write.putMany("session", Array.from({ length: 163 }, (_, i) => ({
                        id: `pipe-session-${String(i).padStart(3, "0")}`,
                        repository: "pipe-repo", cwd: dir, project: "pipe-fixture",
                        source: i < 161 ? "claude" : "claude-subagent",
                        started_at: new Date(now.getTime() - i * 1000), ended_at: now,
                    })));
                    yield* write.putMany("turn", Array.from({ length: 163 }, (_, i) => ({
                        id: `pipe-turn-${i}`, session: `pipe-session-${String(i).padStart(3, "0")}`,
                        seq: 1, ts: now, role: "user", message_kind: "task", text_excerpt: summary,
                    })));
                }),
            ));
            const options = command === "here"
                ? ["here", "--days=7", "--limit=150", "--no-stale-check"]
                : command === "around"
                    ? ["around", now.toISOString(), "--days=7"]
                    : ["near", "HEAD", "--no-stale-check"];
            const args = ["bun", CLI, "sessions", ...options, "--json"];
            const env = {
                ...process.env,
                AX_DUCKDB_SNAPSHOT: fixture.snapshotPath,
                AX_SIDECAR_PATH: `${dir}/judgment.sqlite`,
                AX_NO_AUTO_INGEST: "1", AX_PROGRESS: "off", NO_COLOR: "1",
            };
            const referenceFile = Bun.file(`${dir}/reference.json`);
            const started = performance.now();
            const reference = Bun.spawn(args, { cwd: dir, env, stdout: referenceFile, stderr: "pipe", detached: true });
            children.add(reference);
            const referenceStderr = await new Response(reference.stderr).text();
            expect(await reference.exited, referenceStderr).toBe(0);
            const readerDelayMs = Math.ceil((performance.now() - started) * 2 + 1000);
            const text = await referenceFile.text();
            const body = JSON.parse(text);
            expect(body.sessions.length).toBe(command === "here" ? 150 : 163);
            expect(body.sessions.every((row: { turn_count: number; first_user_message: string }) =>
                row.turn_count === 1 && row.first_user_message === summary)).toBe(true);
            expect(Buffer.byteLength(text)).toBeGreaterThan(64 * 1024);
            const consumer = `
await Bun.sleep(${readerDelayMs});
const text = await new Response(Bun.stdin.stream()).text();
let valid = false;
try { JSON.parse(text); valid = true; } catch {}
console.log(JSON.stringify({ bytes: Buffer.byteLength(text), valid, digest: new Bun.CryptoHasher("sha256").update(text).digest("hex") }));
`;
            const child = Bun.spawn([
                "bash", "-o", "pipefail", "-c", '"$@" | bun -e "$AX_PIPE_CONSUMER"',
                "ax-sessions-list-pipe", ...args,
            ], { cwd: dir, env: { ...env, AX_PIPE_CONSUMER: consumer }, stdout: "pipe", stderr: "pipe", detached: true });
            children.add(child);
            const [stdout, stderr, exitCode] = await Promise.all([
                new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
            ]);
            expect(exitCode, stderr).toBe(0);
            const result = JSON.parse(stdout) as { bytes: number; valid: boolean; digest: string };
            expect(result.bytes).toBe(Buffer.byteLength(text));
            expect(result.valid).toBe(true);
            expect(result.digest).toBe(new Bun.CryptoHasher("sha256").update(text).digest("hex"));
        }, 60_000);
    }
});
