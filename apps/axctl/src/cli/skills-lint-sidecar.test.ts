import { describe, expect } from "bun:test";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer, Schema } from "effect";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CacheReadLayer } from "@ax/lib/duckdb/seam";
import { Judgment, JudgmentLayer, TextColumn } from "@ax/lib/sqlite";
import { skillRowId } from "@ax/lib/stable-id";
import { publishCacheFixture } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";
import { SIDECAR_SCHEMA_SQL } from "@ax/schema/sidecar-ddl";
import { cmdSkillsLint } from "./skills-lint.ts";

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("skills lint sidecar", { requireFts: true });

describe("cmdSkillsLint SQLite judgment port", () => {
    dtest("writes brief role decisions atomically to the judgment sidecar", async () => {
        const directory = tempDir("ax-skills-lint-sidecar-");
        const taskDir = join(directory, "tasks");
        const briefPath = join(taskDir, "classify-tdd.md");
        const cache = await Effect.runPromise(
            publishCacheFixture(directory, dylibPath, (write) =>
                write.put("skill", {
                    id: skillRowId("tdd"),
                    name: "tdd",
                    scope: "user",
                    dir_path: "/tmp/tdd",
                    content_hash: "hash-tdd",
                }),
            ).pipe(Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer))),
        );
        mkdirSync(taskDir, { recursive: true });
        await Bun.write(briefPath, `---\nax_classify: tdd\nprimary_role: verification\nsecondary: [execution]\nconfidence: 0.8\nrationale: trusted check\n---\n`);

        const judgmentLayer = JudgmentLayer({
            sidecarPath: join(directory, "judgment.sqlite"),
            schemaSql: SIDECAR_SCHEMA_SQL,
        });
        const layer = Layer.mergeAll(
            BunFileSystem.layer,
            BunPath.layer,
            judgmentLayer,
            CacheReadLayer({
                snapshotPath: cache.snapshotPath,
                ...(dylibPath === null ? {} : { assetPath: dylibPath }),
            }),
        );

        await Effect.runPromise(
            cmdSkillsLint({ taskDir, dryRun: false, json: true }).pipe(
                Effect.provide(layer),
                Effect.scoped,
            ),
        );

        const rows = await Effect.runPromise(
            Effect.gen(function* () {
                const judgment = yield* Judgment;
                return yield* judgment.rows(
                    Schema.Struct({ source: TextColumn, role_name: TextColumn }),
                    `SELECT p.source, r.name AS role_name
                     FROM plays_role p JOIN role r ON r.id = p.out_id
                     ORDER BY r.name`,
                );
            }).pipe(Effect.provide(judgmentLayer), Effect.scoped),
        );
        expect(rows).toEqual([
            { source: "brief", role_name: "execution" },
            { source: "brief", role_name: "verification" },
        ]);
        expect(await Bun.file(briefPath).exists()).toBe(false);
    });
});
