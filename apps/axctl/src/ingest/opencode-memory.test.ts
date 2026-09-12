import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A large snapshot part is representative of OpenCode stores, but contributes
// no transcript text. Holding every raw part used to cost ~700 MiB here (#1148).
test("OpenCode extraction does not retain the database's raw part payloads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ax-opencode-memory-"));
    const path = join(dir, "opencode.db");
    try {
        const db = new Database(path);
        try {
            db.run("CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER)");
            db.run("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)");
            db.run("CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)");
            db.run("CREATE INDEX message_session ON message(session_id)");
            db.run("CREATE INDEX part_message ON part(message_id)");
            const session = db.query("INSERT INTO session VALUES (?, '/tmp/acme-app', 'memory', 1, 2)");
            const message = db.query("INSERT INTO message VALUES (?, ?, 1, ?)");
            const part = db.query("INSERT INTO part VALUES (?, ?, ?, 1, ?)");
            const payload = JSON.stringify({ type: "step-start", snapshot: "x".repeat(32768) });
            db.transaction(() => {
                for (let i = 0; i < 8192; i++) {
                    const id = `session-${Math.floor(i / 128)}`;
                    if (i % 128 === 0) session.run(id);
                    message.run(`message-${i}`, id, '{"role":"assistant"}');
                    part.run(`part-${i}`, `message-${i}`, id, payload);
                }
            })();
        } finally {
            db.close();
        }
        // Isolate RSS from other tests and fixture creation. No forced GC:
        // production extraction must also release raw rows without it.
        const child = Bun.spawn([process.execPath, "--eval", `
            import { extractOpenCodeDatabase } from ${JSON.stringify(new URL("./opencode.ts", import.meta.url).pathname)};
            const result = extractOpenCodeDatabase(${JSON.stringify(path)});
            console.log(JSON.stringify({sessions: result.sessions.length, turns: result.turns.length,
                warnings: result.warnings, rss: process.memoryUsage().rss}));
        `], { stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr, code] = await Promise.all([
            new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
        const result = JSON.parse(stdout);
        expect(result).toMatchObject({ sessions: 64, turns: 8192, warnings: [] });
        expect(result.rss).toBeLessThan(384 * 1024 * 1024);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}, 30_000);
