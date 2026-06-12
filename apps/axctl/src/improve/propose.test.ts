import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { SurrealClient, type SurrealClientShape } from "@ax/lib/db";
import {
    buildProposeStatements,
    decodeProposeInput,
    runPropose,
    type ProposeInput,
} from "./propose.ts";

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

describe("decodeProposeInput", () => {
    test("accepts a valid guidance proposal", async () => {
        const decoded = await Effect.runPromise(decodeProposeInput(guidanceInput));
        expect(decoded.form).toBe("guidance");
    });

    test("rejects unknown form", async () => {
        const bad = { ...guidanceInput, form: "wish" };
        await expect(Effect.runPromise(decodeProposeInput(bad))).rejects.toThrow();
    });

    test("rejects missing payload field", async () => {
        const bad = {
            ...guidanceInput,
            payload: { file_target: "CLAUDE.md" },
        };
        await expect(Effect.runPromise(decodeProposeInput(bad))).rejects.toThrow();
    });

    test("rejects bad confidence", async () => {
        const bad = { ...guidanceInput, confidence: "certain" };
        await expect(Effect.runPromise(decodeProposeInput(bad))).rejects.toThrow();
    });
});

describe("buildProposeStatements", () => {
    test("fresh sig: CREATE with origin agent + payload UPSERT", () => {
        const stmts = buildProposeStatements(guidanceInput, "guidance__abc123", true);
        expect(stmts).toHaveLength(2);
        expect(stmts[0]).toContain("CREATE proposal:");
        expect(stmts[0]).toContain('origin: "agent"');
        expect(stmts[0]).toContain('status: "open"');
        expect(stmts[0]).toContain('dedupe_sig: "guidance__abc123"');
        expect(stmts[1]).toContain("UPSERT guidance_proposal:");
        expect(stmts[1]).toContain("suggested_text:");
    });

    test("existing sig: frequency bump, no CREATE, payload still upserted", () => {
        const stmts = buildProposeStatements(guidanceInput, "guidance__abc123", false);
        expect(stmts).toHaveLength(2);
        expect(stmts[0]).toContain("UPDATE proposal SET");
        expect(stmts[0]).toContain("frequency = frequency + 1");
        expect(stmts[0]).toContain('WHERE dedupe_sig = "guidance__abc123"');
        expect(stmts[0]).not.toContain("CREATE");
        expect(stmts[1]).toContain("UPSERT guidance_proposal:");
    });

    test("skill form writes skill_proposal payload", () => {
        const input: ProposeInput = {
            form: "skill",
            title: "Batch reads",
            hypothesis: "h",
            confidence: "medium",
            payload: {
                trigger_pattern: "multi-file feature work",
                suspected_gap: "sequential reads",
                proposed_behavior: "batch upfront",
            },
        };
        const stmts = buildProposeStatements(input, "skill__def", true);
        expect(stmts[1]).toContain("UPSERT skill_proposal:");
        expect(stmts[1]).toContain('trigger_pattern: "multi-file feature work"');
    });
});

describe("runPropose", () => {
    const makeDb = (existingRows: Array<{ id: string }>, log: string[]) => {
        const stub: SurrealClientShape = {
            query: (sql: string) => {
                log.push(sql);
                return Effect.succeed(
                    sql.startsWith("SELECT id FROM proposal")
                        ? [existingRows]
                        : [[]],
                );
            },
        } as unknown as SurrealClientShape;
        return Layer.succeed(SurrealClient, stub);
    };

    test("fresh proposal: status created, CREATE executed", async () => {
        const log: string[] = [];
        const res = await Effect.runPromise(
            runPropose(guidanceInput).pipe(Effect.provide(makeDb([], log))),
        );
        expect(res.status).toBe("created");
        expect(res.sig.startsWith("guidance__")).toBe(true);
        expect(log.some((s) => s.startsWith("CREATE proposal:"))).toBe(true);
    });

    test("existing sig: status bumped, UPDATE executed", async () => {
        const log: string[] = [];
        const res = await Effect.runPromise(
            runPropose(guidanceInput).pipe(
                Effect.provide(makeDb([{ id: "proposal:x" }], log)),
            ),
        );
        expect(res.status).toBe("bumped");
        expect(log.some((s) => s.startsWith("UPDATE proposal SET"))).toBe(true);
        expect(log.some((s) => s.startsWith("CREATE proposal:"))).toBe(false);
    });
});
