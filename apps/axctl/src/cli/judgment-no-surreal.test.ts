import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Judgment, JudgmentLayer, NumberColumn } from "@ax/lib/sqlite";
import { SIDECAR_SCHEMA_SQL } from "@ax/schema/sidecar-ddl";

const runCli = async (sidecarPath: string, args: string[]) => {
    const child = Bun.spawn(["bun", "apps/axctl/src/cli/index.ts", ...args], {
        cwd: process.cwd(),
        env: { ...process.env, AX_DEV: "1", AX_SIDECAR_PATH: sidecarPath, AX_DB_URL: "ws://127.0.0.1:1/rpc" },
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    return { stdout, stderr, exitCode };
};

describe("judgment commands without SurrealDB", () => {
    test("improve, retro, and dogfood reads use only SQLite", async () => {
        const root = mkdtempSync(join(tmpdir(), "ax-no-surreal-"));
        const sidecarPath = join(root, "judgment.sqlite");
        await Effect.runPromise(Effect.gen(function* () {
            const judgment = yield* Judgment;
            const now = new Date("2026-01-01T00:00:00Z");
            yield* judgment.put("proposal", {
                id: "p1", form: "guidance", title: "Use rg", hypothesis: "faster", dedupe_sig: "use-rg",
                frequency: 1, confidence: "high", status: "open", origin: "agent",
                hypothesis_template: null, evidence_query: null, reject_reason: null, baseline: null,
                created_at: now, updated_at: now,
            });
            yield* judgment.put("retro", {
                id: "r1", session: "s1", source: "manual", tried: "test", worked: null,
                failed: null, next: null, raw: null, repository: null, created_at: now,
            });
            yield* judgment.put("dogfood_run", {
                id: "d1", run_id: "run-1", scenario: "interactive", driver: "wterm", status: "completed",
                agent: null, command: "true", command_source: "override", transport: "process",
                requested_transport: "process", transport_fallback_reason: null, success_marker: null,
                marker_found: true, timed_out: false, timeout_seconds: null, transcript_artifact: null,
                cwd: "/tmp", started_at: now, ended_at: now,
            });
            const count = yield* judgment.rows(
                Schema.Struct({ count: NumberColumn }), "SELECT count(*) AS count FROM proposal",
            );
            expect(count[0]?.count).toBe(1);
        }).pipe(Effect.provide(JudgmentLayer({ sidecarPath, schemaSql: SIDECAR_SCHEMA_SQL })), Effect.scoped));

        const improve = await runCli(sidecarPath, ["improve", "list", "--json"]);
        const retro = await runCli(sidecarPath, ["retro", "list", "--json"]);
        const dogfood = await runCli(sidecarPath, ["dogfood", "runs", "--json"]);
        for (const result of [improve, retro, dogfood]) {
            expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(0);
            expect(result.stderr).not.toContain("127.0.0.1:1");
        }
        expect(improve.stdout).toContain("use-rg");
        expect(retro.stdout).toContain("manual");
        expect(dogfood.stdout).toContain("run-1");
    });

    test("manual retro emit uses SQLite when the session and file are explicit", async () => {
        const root = mkdtempSync(join(tmpdir(), "ax-retro-emit-no-surreal-"));
        const sidecarPath = join(root, "judgment.sqlite");
        const payloadPath = join(root, "retro.json");
        writeFileSync(payloadPath, JSON.stringify({ tried: "port judgments", worked: "SQLite" }));

        const result = await runCli(sidecarPath, [
            "retro", "emit", "--session=session-manual", `--from-file=${payloadPath}`, "--json",
        ]);
        expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(0);
        expect(result.stderr).not.toContain("127.0.0.1:1");
        expect(result.stdout).toContain("session:session-manual");

        const count = await Effect.runPromise(Effect.gen(function* () {
            const judgment = yield* Judgment;
            const rows = yield* judgment.rows(
                Schema.Struct({ count: NumberColumn }),
                "SELECT count(*) AS count FROM retro WHERE session = ?",
                ["session-manual"],
            );
            return rows[0]?.count ?? 0;
        }).pipe(Effect.provide(JudgmentLayer({ sidecarPath, schemaSql: SIDECAR_SCHEMA_SQL })), Effect.scoped));
        expect(count).toBe(1);
    });
});
