import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
    loadDiagnosticConfig,
    normalizeDiagnosticIssue,
    parseDiagnosticConfig,
    queryLiveDiagnostics,
} from "./diagnostics.ts";

async function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
    const root = await mkdtemp(join(tmpdir(), "agentctl-diagnostics-"));
    try {
        return await fn(root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

async function writeDiagnosticConfig(
    root: string,
    diagnostics: {
        readonly healthUrl?: string;
        readonly statusUrl?: string;
        readonly errorsUrl?: string;
        readonly timeoutMs?: number;
    },
): Promise<void> {
    const dir = join(root, ".agentctl");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "config.json"), JSON.stringify({ diagnostics }), "utf8");
}

describe("parseDiagnosticConfig", () => {
    test("reads URLs from .agentctl config JSON", () => {
        const parsed = parseDiagnosticConfig(
            JSON.stringify({
                diagnostics: {
                    healthUrl: "http://localhost:4319/internal/health",
                    statusUrl: "http://localhost:4319/internal/status",
                    errorsUrl: "http://localhost:4319/internal/errors",
                    timeoutMs: 750,
                },
            }),
        );

        expect(parsed).toEqual({
            healthUrl: "http://localhost:4319/internal/health",
            statusUrl: "http://localhost:4319/internal/status",
            errorsUrl: "http://localhost:4319/internal/errors",
            timeoutMs: 750,
        });
    });
});

describe("loadDiagnosticConfig", () => {
    test("returns null when .agentctl/config.json is absent", async () => {
        await withTempRoot(async (root) => {
            const config = await Effect.runPromise(loadDiagnosticConfig(root));

            expect(config).toBeNull();
        });
    });

    test("loads .agentctl/config.json when present", async () => {
        await withTempRoot(async (root) => {
            await writeDiagnosticConfig(root, {
                healthUrl: "http://localhost:4319/internal/health",
                statusUrl: "http://localhost:4319/internal/status",
                errorsUrl: "http://localhost:4319/internal/errors",
                timeoutMs: 750,
            });

            const config = await Effect.runPromise(loadDiagnosticConfig(root));

            expect(config).toEqual({
                healthUrl: "http://localhost:4319/internal/health",
                statusUrl: "http://localhost:4319/internal/status",
                errorsUrl: "http://localhost:4319/internal/errors",
                timeoutMs: 750,
            });
        });
    });
});

describe("normalizeDiagnosticIssue", () => {
    test("normalizes Quera-devkit-style issue objects", () => {
        expect(
            normalizeDiagnosticIssue({
                severity: "critical",
                title: "backend crashed",
                detail: "exit 1",
                suggestedAction: "check stderr",
                traceId: "abc",
                service: "backend",
            }),
        ).toEqual({
            severity: "critical",
            title: "backend crashed",
            detail: "exit 1",
            suggestedAction: "check stderr",
            traceId: "abc",
            service: "backend",
        });
    });
});

describe("queryLiveDiagnostics", () => {
    test("returns unavailable diagnostics when config is absent", async () => {
        await withTempRoot(async (root) => {
            const diagnostics = await Effect.runPromise(queryLiveDiagnostics(root));

            expect(diagnostics).toEqual({
                configured: false,
                available: false,
                source: null,
                status: "unknown",
                issues: [],
                localUrls: [],
                checkedAt: expect.any(String),
                error: null,
            });
        });
    });

    test("queries a local health URL and returns live diagnostics", async () => {
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch() {
                return Response.json({
                    status: "yellow",
                    issues: [
                        {
                            severity: "warning",
                            title: "worker slow",
                            detail: "queue depth 3",
                            suggestedAction: "inspect worker",
                            traceId: "trace-1",
                            service: "worker",
                        },
                    ],
                    localUrls: ["http://localhost:3000", 42, "http://localhost:3001"],
                });
            },
        });

        try {
            await withTempRoot(async (root) => {
                const healthUrl = `http://127.0.0.1:${server.port}/internal/health`;
                await writeDiagnosticConfig(root, {
                    healthUrl,
                    timeoutMs: 1000,
                });

                const diagnostics = await Effect.runPromise(queryLiveDiagnostics(root));

                expect(diagnostics).toEqual({
                    configured: true,
                    available: true,
                    source: healthUrl,
                    status: "yellow",
                    issues: [
                        {
                            severity: "warning",
                            title: "worker slow",
                            detail: "queue depth 3",
                            suggestedAction: "inspect worker",
                            traceId: "trace-1",
                            service: "worker",
                        },
                    ],
                    localUrls: ["http://localhost:3000", "http://localhost:3001"],
                    checkedAt: expect.any(String),
                    error: null,
                });
            });
        } finally {
            server.stop(true);
        }
    });

    test("returns configured unavailable diagnostics when health URL returns non-2xx", async () => {
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch() {
                return new Response("unhealthy", { status: 503 });
            },
        });

        try {
            await withTempRoot(async (root) => {
                await writeDiagnosticConfig(root, {
                    healthUrl: `http://127.0.0.1:${server.port}/internal/health`,
                    timeoutMs: 1000,
                });

                const diagnostics = await Effect.runPromise(queryLiveDiagnostics(root));

                expect(diagnostics).toEqual({
                    configured: true,
                    available: false,
                    source: null,
                    status: "unknown",
                    issues: [],
                    localUrls: [],
                    checkedAt: expect.any(String),
                    error: "Error: diagnostics returned HTTP 503",
                });
            });
        } finally {
            server.stop(true);
        }
    });
});
