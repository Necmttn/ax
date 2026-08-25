/**
 * Regression test for #688: a large `--json` payload piped into a slow
 * downstream reader (e.g. `| jq`) must arrive complete. `console.log`/a bare
 * `process.stdout.write(...)` resolve before the OS pipe drains, so a
 * process that exits right after can truncate the write mid-stream under
 * real backpressure. `writeJsonStdout` (cli/output.ts) fixes this by
 * awaiting the stream's write-completion callback before returning.
 *
 * The reader in this test deliberately paces its reads with a delay so the
 * OS pipe buffer fills and the child process genuinely observes
 * backpressure (`write()` returning `false`) instead of racing a fast
 * consumer that would mask the bug.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

const OUTPUT_MODULE = new URL("./output.ts", import.meta.url).pathname;

describe("writeJsonStdout backpressure (#688)", () => {
    test("a slow reader receives the exact, complete JSON payload and the writer exits 0", async () => {
        const payload = JSON.stringify({ big: "x".repeat(230 * 1024) });
        const payloadBytes = Buffer.byteLength(payload, "utf8");
        expect(payloadBytes).toBeGreaterThan(218 * 1024);

        const dir = await mkdtemp(path.join(tmpdir(), "ax-json-output-"));
        const fixturePath = path.join(dir, "slow-reader-fixture.ts");
        // A minimal standalone script exercising exactly the production
        // write path (`writeJsonStdout`), then exiting immediately - the
        // worst case for a fire-and-forget write, since there is no other
        // pending work to keep the process alive until the pipe drains.
        const fixture = `
import { writeJsonStdout } from ${JSON.stringify(OUTPUT_MODULE)};
const payload = ${JSON.stringify(payload)};
await writeJsonStdout(payload);
process.exit(0);
`;
        await writeFile(fixturePath, fixture);

        try {
            const proc = Bun.spawn(["bun", fixturePath], {
                stdout: "pipe",
                stderr: "inherit",
            });
            const reader = proc.stdout.getReader();
            const chunks: Uint8Array[] = [];
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value) chunks.push(value);
                // Slow reader: pace reads so the pipe buffer fills and the
                // writer must actually wait out backpressure, not just win
                // a race against a fast consumer.
                await new Promise((resolve) => setTimeout(resolve, 15));
            }
            const exitCode = await proc.exited;
            const received = Buffer.concat(chunks).toString("utf8");
            const expected = `${payload}\n`;

            expect(exitCode).toBe(0);
            expect(received.length).toBe(expected.length);
            expect(received).toBe(expected);
            expect(JSON.parse(received)).toEqual(JSON.parse(payload));
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    }, 20_000);
});
