import { describe, expect, test } from "bun:test";
import { normalizeDiagnosticIssue, parseDiagnosticConfig } from "./diagnostics.ts";

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
