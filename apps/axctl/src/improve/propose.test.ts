import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Judgment, JudgmentLayer, NumberColumn, TextColumn } from "@ax/lib/sqlite";
import { SIDECAR_SCHEMA_SQL } from "@ax/schema/sidecar-ddl";
import { decodeProposeInput, runPropose, type ProposeInput } from "./propose.ts";

const guidanceInput: ProposeInput = {
    form: "guidance",
    title: "Always run typecheck before commit",
    hypothesis: "5 sessions repaired type errors post-commit",
    confidence: "high",
    evidence: "sessions: 01ja, 01jb",
    payload: {
        file_target: "CLAUDE.md",
        suggested_text: "Run `bun run typecheck` before every commit.",
    },
};

const directories: string[] = [];
afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const fixture = () => {
    const directory = mkdtempSync(join(tmpdir(), "ax-propose-sidecar-"));
    directories.push(directory);
    return JudgmentLayer({
        sidecarPath: join(directory, "judgment.sqlite"),
        schemaSql: SIDECAR_SCHEMA_SQL,
    });
};

describe("decodeProposeInput", () => {
    test("accepts a valid guidance proposal", async () => {
        const decoded = await Effect.runPromise(decodeProposeInput(guidanceInput));
        expect(decoded.form).toBe("guidance");
    });

    test("rejects invalid form, payload, and confidence", async () => {
        await expect(Effect.runPromise(decodeProposeInput({ ...guidanceInput, form: "wish" }))).rejects.toThrow();
        await expect(Effect.runPromise(decodeProposeInput({ ...guidanceInput, payload: { file_target: "CLAUDE.md" } }))).rejects.toThrow();
        await expect(Effect.runPromise(decodeProposeInput({ ...guidanceInput, confidence: "certain" }))).rejects.toThrow();
    });
});

describe("runPropose", () => {
    test("creates and bumps one proposal with one typed payload row", async () => {
        const layer = fixture();
        const first = await Effect.runPromise(runPropose(guidanceInput).pipe(Effect.provide(layer), Effect.scoped));
        const second = await Effect.runPromise(
            runPropose({ ...guidanceInput, hypothesis: "new evidence", confidence: "medium" }).pipe(
                Effect.provide(layer),
                Effect.scoped,
            ),
        );

        expect(first.status).toBe("created");
        expect(second.status).toBe("bumped");
        const stored = await Effect.runPromise(
            Effect.gen(function* () {
                const judgment = yield* Judgment;
                const proposals = yield* judgment.rows(
                    Schema.Struct({
                        frequency: NumberColumn,
                        hypothesis: TextColumn,
                        confidence: TextColumn,
                        origin: TextColumn,
                    }),
                    "SELECT frequency, hypothesis, confidence, origin FROM proposal",
                );
                const payloads = yield* judgment.rows(
                    Schema.Struct({ proposal: TextColumn, file_target: TextColumn, suggested_text: TextColumn }),
                    "SELECT proposal, file_target, suggested_text FROM guidance_proposal",
                );
                return { proposals, payloads };
            }).pipe(Effect.provide(layer), Effect.scoped),
        );
        expect(stored.proposals).toEqual([{
            frequency: 2,
            hypothesis: "new evidence",
            confidence: "medium",
            origin: "agent",
        }]);
        expect(stored.payloads).toHaveLength(1);
        expect(stored.payloads[0]?.file_target).toBe("CLAUDE.md");
    });

    test("rejects Surreal RETURN evidence queries", async () => {
        const layer = fixture();
        await expect(
            Effect.runPromise(
                runPropose({
                    ...guidanceInput,
                    hypothesis_template: "{{n}} failures",
                    evidence_query: "RETURN { n: 2 }",
                }).pipe(Effect.provide(layer), Effect.scoped),
            ),
        ).rejects.toThrow("read-only SELECT");
    });
});
