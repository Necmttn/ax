import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import { Judgment, JudgmentLayer } from "@ax/lib/sqlite";
import { SIDECAR_SCHEMA_SQL } from "@ax/schema/sidecar-ddl";
import { clearSkillDecision, listSkillDecisions, setSkillDecision, setSkillDecisionsBulk } from "./triage.ts";

const deadSurreal = Layer.succeed(
    SurrealClient,
    new Proxy({} as SurrealClientShape, {
        get(_target, property) {
            throw new Error(`SurrealClient.${String(property)} must not be used by triage decisions`);
        },
    }),
);

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const tempDirectory = (): string => {
    const directory = mkdtempSync(join(tmpdir(), "ax-triage-sidecar-"));
    directories.push(directory);
    return directory;
};

const runWithSidecar = <A, E>(directory: string, effect: Effect.Effect<A, E, Judgment | SurrealClient>) =>
    Effect.runPromise(
        effect.pipe(
            Effect.provide(
                Layer.mergeAll(
                    deadSurreal,
                    JudgmentLayer({
                        sidecarPath: join(directory, "judgment.sqlite"),
                        schemaSql: SIDECAR_SCHEMA_SQL,
                    }),
                ),
            ),
            Effect.scoped,
        ),
    );

describe("skill triage decisions in the judgment sidecar", () => {
    test("sets, lists, replaces, and clears decisions without SurrealDB", async () => {
        const directory = tempDirectory();

        await runWithSidecar(directory, setSkillDecision("tdd", "keep", "reliable"));
        await runWithSidecar(
            directory,
            setSkillDecisionsBulk(["tdd", "review"], "review", null),
        );

        const listed = await runWithSidecar(directory, listSkillDecisions());
        expect(listed.map(({ skill_name, decision, reason }) => ({ skill_name, decision, reason }))).toEqual([
            { skill_name: "tdd", decision: "review", reason: null },
            { skill_name: "review", decision: "review", reason: null },
        ]);

        await runWithSidecar(directory, clearSkillDecision("tdd"));
        const afterClear = await runWithSidecar(directory, listSkillDecisions());
        expect(afterClear.map((row) => row.skill_name)).toEqual(["review"]);
    });
});
