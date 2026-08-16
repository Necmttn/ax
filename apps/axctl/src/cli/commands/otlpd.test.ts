import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { formatOtlpdPortBusy, runOtlpd } from "./otlpd.ts";

describe("formatOtlpdPortBusy", () => {
    it("names the port and hints ax studio may own it - no stack trace", () => {
        const msg = formatOtlpdPortBusy(1738);
        expect(msg).toContain("1738");
        expect(msg).toContain("ax studio");
        expect(msg).not.toContain("Error:");
        expect(msg).not.toContain("    at ");
    });
});

describe("runOtlpd port collision", () => {
    const roots: string[] = [];
    const platformLayer = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);

    afterEach(async () => {
        for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
    });

    it("exits cleanly (exit code 1, no throw) when the port is already bound by something else", async () => {
        const spoolDir = await mkdtemp(join(tmpdir(), "ax-otlpd-cli-"));
        roots.push(spoolDir);
        const occupied = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
        const prevExitCode = process.exitCode;
        const errors: unknown[] = [];
        const originalError = console.error;
        console.error = (...args: unknown[]) => {
            errors.push(args);
        };
        try {
            await Effect.runPromise(
                runOtlpd({ spoolDir, port: occupied.port ?? 0 }).pipe(Effect.provide(platformLayer)),
            );
            expect(process.exitCode).toBe(1);
            expect(errors).toHaveLength(1);
            expect(String(errors[0])).toContain(String(occupied.port));
        } finally {
            console.error = originalError;
            process.exitCode = prevExitCode;
            occupied.stop(true);
        }
    });
});
