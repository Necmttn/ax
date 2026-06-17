import { describe, expect, test } from "bun:test";
import type { OtelLogEventRow } from "../otel/rows.ts";
import { projectHarnessRunContext } from "./harness-run-context.ts";

const row = (overrides: Partial<OtelLogEventRow>): OtelLogEventRow => ({
    harness: "codex",
    event_name: "codex.conversation_starts",
    session_id: null,
    model: null,
    input_tokens: null,
    output_tokens: null,
    reasoning_tokens: null,
    cached_tokens: null,
    tool_tokens: null,
    duration_ms: null,
    status_code: null,
    attrs: null,
    observed_at: new Date("2026-06-17T00:00:00Z"),
    ...overrides,
});

describe("projectHarnessRunContext", () => {
    test("projects Codex conversation start attrs into shared run context", () => {
        const projected = projectHarnessRunContext(
            row({
                attrs: JSON.stringify({
                    "conversation.id": "c1",
                    model: "gpt-5-codex",
                    reasoning_effort: "high",
                    reasoning_summary: "auto",
                    approval_policy: "never",
                    sandbox_policy: "workspace-write",
                    mcp_servers: "github,linear",
                    auth_mode: "api-key",
                    originator: "codex_exec",
                    "terminal.type": "xterm-256color",
                    "app.version": "1.2.3",
                }),
            }),
        );

        expect(projected).toMatchObject({
            sessionId: "c1",
            harness: "codex",
            surface: "exec",
            entrypoint: "local-noninteractive",
            deploymentProvider: "local",
            model: "gpt-5-codex",
            reasoningEffort: "high",
            reasoningSummary: "auto",
            approvalPolicy: "never",
            sandboxPolicy: "workspace-write",
            mcpServers: "github,linear",
            authMode: "api-key",
            terminalType: "xterm-256color",
            appVersion: "1.2.3",
        });
        expect(projected.attrs).toEqual({
            "conversation.id": "c1",
            model: "gpt-5-codex",
            reasoning_effort: "high",
            reasoning_summary: "auto",
            approval_policy: "never",
            sandbox_policy: "workspace-write",
            mcp_servers: "github,linear",
            auth_mode: "api-key",
            originator: "codex_exec",
            "terminal.type": "xterm-256color",
            "app.version": "1.2.3",
        });
    });

    test("projects Claude api_request attrs into shared run context", () => {
        const projected = projectHarnessRunContext(
            row({
                harness: "claude",
                event_name: "claude_code.api_request",
                attrs: JSON.stringify({
                    "session.id": "s1",
                    model: "claude-sonnet-4-5-20250929",
                    "app.version": "2.0.0",
                    "permission.mode": "acceptEdits",
                    entrypoint: "sdk",
                }),
            }),
        );

        expect(projected).toMatchObject({
            sessionId: "s1",
            harness: "claude",
            surface: "sdk",
            entrypoint: "embedded-sdk",
            deploymentProvider: "local",
            model: "claude-sonnet-4-5-20250929",
            permissionProfile: "acceptEdits",
            appVersion: "2.0.0",
        });
    });

    test("uses empty attrs for null, malformed, or non-object attr payloads", () => {
        expect(projectHarnessRunContext(row({ attrs: null })).attrs).toEqual({});
        expect(projectHarnessRunContext(row({ attrs: JSON.stringify(["not", "object"]) })).attrs).toEqual({});
        expect(projectHarnessRunContext(row({ attrs: JSON.stringify("not-object") })).attrs).toEqual({});

        const malformed = projectHarnessRunContext(row({ attrs: "{not-json" }));

        expect(malformed.sessionId).toBeNull();
        expect(malformed.attrs).toEqual({});
    });

    test("projects only non-empty string attrs into string fields", () => {
        const projected = projectHarnessRunContext(
            row({
                attrs: JSON.stringify({
                    "conversation.id": 123,
                    "session.id": "  ",
                    model: true,
                    provider_name: 45,
                    model_provider: "  anthropic  ",
                    reasoning_effort: "",
                    reasoning_summary: "  auto  ",
                    approval_policy: false,
                    sandbox_policy: " workspace-write ",
                    permission_profile: "",
                    "permission.mode": "acceptEdits",
                    web_search_mode: "   ",
                    mcp_servers: ["github"],
                    "app.version": "  1.2.3 ",
                    "terminal.type": 99,
                }),
            }),
        );

        expect(projected).toMatchObject({
            sessionId: null,
            model: null,
            modelProvider: "anthropic",
            reasoningEffort: null,
            reasoningSummary: "auto",
            approvalPolicy: null,
            sandboxPolicy: "workspace-write",
            permissionProfile: "acceptEdits",
            webSearchMode: null,
            mcpServers: null,
            appVersion: "1.2.3",
            terminalType: null,
        });
    });
});
