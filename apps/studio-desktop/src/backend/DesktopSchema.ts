/**
 * DesktopSchema - the desktop app applies the SurrealDB schema on boot.
 *
 * Under the IDE daemon model the desktop owns the database end to end (no CLI
 * `ax install` LaunchAgents). Previously ONLY `cmdInstall` applied the schema
 * (`surreal import` against a running DB); neither `ax serve` nor the supervisor
 * did. So when the app owns surreal it must apply the schema itself, after
 * surreal is ready and before `ax serve` starts. Mirrors `cmdInstall`: bucket
 * BACKEND paths are rewritten to this machine's buckets dir (the committed
 * schema.surql carries the committing machine's absolute path, which the
 * daemon's bucket allowlist would otherwise deny - issue #251), and the import
 * runs ns=ax db=main to match `makeAxServeConfig`.
 *
 * See docs/superpowers/specs/2026-06-16-smappservice-background-helper-design.md
 */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { bucketNames, renderBucketBackends } from "@ax/schema/render";
import schemaSurql from "@ax/schema/schema.surql" with { type: "text" };

import { makeComponentLogger } from "../app/DesktopObservability.ts";
import { SURREAL_PORT } from "./AxDaemonArbitration.ts";

const { logInfo, logError } = makeComponentLogger("desktop-schema");

/** Just the environment fields the schema importer needs (kept local to avoid a cycle with AxBackendManager). */
export interface SchemaApplyEnv {
    readonly surrealBinaryPath: string;
    /** Canonical ax data dir; buckets live under `<axDataDir>/buckets`. */
    readonly axDataDir: string;
}

/**
 * `surreal import` argv targeting the locally-spawned surreal. ns/db must match
 * `makeAxServeConfig` (ax/main) so serve reads the schema we wrote.
 */
export const buildSchemaImportArgs = (opts: {
    readonly surrealPort: number;
    readonly schemaFile: string;
}): Array<string> => [
    "import",
    "--endpoint",
    `http://127.0.0.1:${opts.surrealPort}`,
    "--user",
    "root",
    "--pass",
    "root",
    "--ns",
    "ax",
    "--db",
    "main",
    opts.schemaFile,
];

/**
 * Render + import the embedded schema into the spawned surreal. Idempotent
 * (safe on every boot). Fail-soft: a failed import is logged, not thrown, so a
 * schema hiccup never blocks the app from opening (`E = never`).
 */
export const applySchema = (
    env: SchemaApplyEnv,
): Effect.Effect<
    void,
    never,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
    Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

        // Ensure the buckets dir + per-bucket subdirs exist before import, so the
        // bucket BACKEND paths resolve (mirrors cmdInstall's ensureDirs).
        const bucketsDir = path.join(env.axDataDir, "buckets");
        yield* fs.makeDirectory(bucketsDir, { recursive: true });
        for (const bucket of bucketNames(schemaSurql)) {
            yield* fs.makeDirectory(path.join(bucketsDir, bucket), { recursive: true });
        }

        const schemaFile = path.join(env.axDataDir, ".schema-cache.surql");
        yield* fs.writeFileString(schemaFile, renderBucketBackends(schemaSurql, bucketsDir));

        const command = ChildProcess.make(
            env.surrealBinaryPath,
            buildSchemaImportArgs({ surrealPort: SURREAL_PORT, schemaFile }),
            { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
        );

        const exit = yield* Effect.scoped(
            Effect.gen(function* () {
                const handle = yield* spawner.spawn(command);
                return yield* handle.exitCode;
            }),
        );

        yield* Number(exit) === 0
            ? logInfo("schema applied", { schemaFile })
            : logError("schema import exited non-zero", { exit: Number(exit) });
    }).pipe(
        Effect.catchCause((cause) =>
            logError("schema apply failed", { cause: Cause.pretty(cause) }),
        ),
    );

/** Injectable shape of {@link applySchema} - lets the supervisor take a no-op in unit tests. */
export type ApplySchema = typeof applySchema;

/** Test/attach-mode default: apply nothing. */
export const noopApplySchema: ApplySchema = () => Effect.void;
