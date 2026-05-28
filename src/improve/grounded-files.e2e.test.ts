/**
 * E2E test for the grounded-files loop: seed proposal → acceptProposal →
 * write marker → lintFiles reconciles.
 *
 * Gated on `AX_E2E_DB=1`. Without that env var the suite skips trivially.
 * Requires a live SurrealDB at ws://127.0.0.1:8521 (or AX_DB_URL override).
 *
 * Uses the real `AppLayer` from src/lib/layers.ts which wires AxConfigLive →
 * SurrealClientLive in one composed layer.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptProposal } from "./actions.ts";
import { lintFiles } from "./lint.ts";
import { AppLayer } from "../lib/layers.ts";
import { SurrealClient } from "../lib/db.ts";
import { surrealString } from "../lib/shared/surql.ts";

// ---------------------------------------------------------------------------
// Skip guard
// ---------------------------------------------------------------------------

const E2E_ENABLED = process.env.AX_E2E_DB === "1";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Seed a minimal guidance proposal + guidance_payload via the live DB. */
const seedProposal = (sig: string) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        // Use UPSERT so reruns after partial cleanup don't collide on the UNIQUE index.
        yield* db.query(`
            UPSERT proposal:e2e_${sig} MERGE {
                form: 'guidance',
                title: 'E2E test proposal',
                hypothesis: 'Use ripgrep instead of grep for faster searches.',
                dedupe_sig: ${surrealString(sig)},
                frequency: 1,
                confidence: 'medium',
                status: 'open',
                created_at: time::now()
            };
            UPSERT guidance_proposal:e2e_${sig} MERGE {
                proposal: proposal:e2e_${sig},
                file_target: 'CLAUDE.md',
                section: 'Terminal Optimization',
                suggested_text: 'Use ripgrep (rg) instead of grep.'
            };
        `);
        return `e2e_${sig}` as const;
    });

/** Delete the seeded proposal + experiment rows by dedupe_sig. */
const cleanupProposal = (sig: string) =>
    Effect.gen(function* () {
        const db = yield* SurrealClient;
        // Delete experiment first (FK reference ON DELETE CASCADE handles the rest,
        // but CASCADE only fires on the SurrealDB record-delete path; explicit is safer).
        yield* db.query(`
            DELETE experiment WHERE proposal = proposal:e2e_${sig};
            DELETE guidance_proposal WHERE proposal = proposal:e2e_${sig};
            DELETE proposal:e2e_${sig};
        `).pipe(Effect.orElse(() => Effect.void));
    });

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("grounded files E2E", () => {
    const sig = `e2e-${Date.now().toString(36)}`;

    // Smoke-guard: if DB unreachable, skip gracefully rather than fail.
    // We detect this by attempting a trivial query in beforeAll.
    let dbReachable = false;

    beforeAll(async () => {
        if (!E2E_ENABLED) return;
        try {
            await Effect.runPromise(
                Effect.gen(function* () {
                    const db = yield* SurrealClient;
                    yield* db.query("RETURN 1;");
                }).pipe(Effect.provide(AppLayer)),
            );
            dbReachable = true;
        } catch (err) {
            console.warn(
                `(grounded-files E2E) SurrealDB unreachable - skipping live tests. Error: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    });

    afterAll(async () => {
        if (!E2E_ENABLED || !dbReachable) return;
        // Best-effort cleanup even if the test failed midway.
        await Effect.runPromise(
            cleanupProposal(sig).pipe(Effect.provide(AppLayer)),
        ).catch(() => {/* ignore cleanup errors */});
    });

    test("derive → accept → mark → lint reconciles", async () => {
        if (!E2E_ENABLED) {
            console.log("(skipped - set AX_E2E_DB=1 with a live SurrealDB to run)");
            expect(true).toBe(true);
            return;
        }

        if (!dbReachable) {
            console.log("(skipped - SurrealDB not reachable)");
            expect(true).toBe(true);
            return;
        }

        // 1. Seed a guidance proposal via live DB.
        await Effect.runPromise(
            seedProposal(sig).pipe(Effect.provide(AppLayer)),
        );

        // 2. acceptProposal emits a task file.
        const root = mkdtempSync(join(tmpdir(), "ax-e2e-"));
        const taskDir = join(root, ".ax", "tasks");

        const acceptResult = await Effect.runPromise(
            acceptProposal({ sigOrId: sig, taskDir }).pipe(
                Effect.provide(AppLayer),
            ),
        );

        expect(acceptResult.status).toBe("ok");
        expect(acceptResult.task_path).toBeDefined();
        expect(existsSync(acceptResult.task_path!)).toBe(true);

        // 3. Simulate user's agent writing the grounded marker into CLAUDE.md.
        const targetFile = join(root, "CLAUDE.md");
        writeFileSync(
            targetFile,
            `# CLAUDE.md\n<!--ax:${sig}-->Use ripgrep (rg).<!--/ax:${sig}-->\n`,
        );

        // 4. lintFiles reconciles: marker found → experiment flips to 'scaffolded'
        //    → task file deleted.
        const report = await Effect.runPromise(
            lintFiles({ roots: [root] }).pipe(Effect.provide(AppLayer)),
        );

        // The marker for our sig should appear in the reconciled list.
        expect(report.reconciled.some((r) => r.shortId === sig)).toBe(true);

        // Task file should have been deleted by lintFiles.
        expect(existsSync(acceptResult.task_path!)).toBe(false);

        // No errors in the report for our file.
        const ourErrors = report.errors.filter((e) => e.path === targetFile);
        expect(ourErrors).toHaveLength(0);
    });
});
