import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { RecordId } from "surrealdb";
import { SurrealClient, type SurrealClientShape } from "./db.ts";
import { deterministicId, writeTelemetryRow, type TelemetryBaseRow } from "./telemetry-base.ts";

describe("deterministicId", () => {
    test("returns the same id for the same parts", () => {
        const a = deterministicId(["claude", "session:abc", "src/a.ts", "1716480000000", "pre-edit"]);
        const b = deterministicId(["claude", "session:abc", "src/a.ts", "1716480000000", "pre-edit"]);
        expect(a).toBe(b);
    });

    test("returns different ids for different parts", () => {
        const a = deterministicId(["claude", "session:abc", "src/a.ts", "1716480000000", "pre-edit"]);
        const b = deterministicId(["claude", "session:abc", "src/b.ts", "1716480000000", "pre-edit"]);
        expect(a).not.toBe(b);
    });

    test("returns a 16-char lowercase hex string", () => {
        const id = deterministicId(["claude", "session:abc", "src/a.ts"]);
        expect(id).toMatch(/^[0-9a-f]{16}$/);
    });
});

describe("writeTelemetryRow", () => {
    test("upserts a record with the table + id provided", async () => {
        const calls: Array<{ id: RecordId; content: Record<string, unknown> }> = [];
        const fake: SurrealClientShape = {
            query: () => Effect.succeed([] as unknown as never),
            upsert: (id, content) =>
                Effect.sync(() => {
                    calls.push({ id, content });
                }),
            relate: () => Effect.void,
            putFile: () => Effect.void,
            getFile: () => Effect.succeed(""),
            raw: {} as never,
        };

        const row: TelemetryBaseRow = {
            id: "deadbeefdeadbeef",
            ts: new Date("2026-05-17T10:00:00Z"),
            kind: "hook_fire",
            session: "session:abc",
            file: undefined,
            file_path: "src/a.ts",
            harness: "claude",
            ok: true,
            latency_ms: 42,
        };

        await Effect.runPromise(
            writeTelemetryRow("hook_fire", row).pipe(Effect.provide(Layer.succeed(SurrealClient, fake))),
        );

        expect(calls).toHaveLength(1);
        expect(calls[0]!.id.toString()).toBe("hook_fire:deadbeefdeadbeef");
        expect(calls[0]!.content.kind).toBe("hook_fire");
        expect(calls[0]!.content.file_path).toBe("src/a.ts");
        expect(calls[0]!.content.session).toBeInstanceOf(RecordId);
        expect(calls[0]!.content.ts).toBeInstanceOf(Date);
    });

    test("omits session and file when undefined", async () => {
        const calls: Array<{ id: RecordId; content: Record<string, unknown> }> = [];
        const fake: SurrealClientShape = {
            query: () => Effect.succeed([] as unknown as never),
            upsert: (id, content) =>
                Effect.sync(() => {
                    calls.push({ id, content });
                }),
            relate: () => Effect.void,
            putFile: () => Effect.void,
            getFile: () => Effect.succeed(""),
            raw: {} as never,
        };

        const row: TelemetryBaseRow = {
            id: "abc123",
            ts: new Date("2026-05-17T10:00:00Z"),
            kind: "hook_fire",
            session: undefined,
            file: undefined,
            file_path: "bun.lock",
            harness: "claude",
            ok: true,
            latency_ms: 1,
        };

        await Effect.runPromise(
            writeTelemetryRow("hook_fire", row).pipe(Effect.provide(Layer.succeed(SurrealClient, fake))),
        );

        expect(calls[0]!.content.session).toBeUndefined();
        expect(calls[0]!.content.file).toBeUndefined();
    });
});
