import { describe, expect, test } from "bun:test";
import {
    AxSessionStoreKeyError,
    axSessionStoreKey,
    axSessionStoreSubpath,
    buildClaudeSdkAppendStatements,
    claudeSdkAppendPayloadToAgentEventBatch,
    parseAxSessionStoreKey,
} from "./session-store.ts";

describe("Claude SDK SessionStore keys", () => {
    test("normalizes and roundtrips project/session keys with a safe subpath", () => {
        const key = axSessionStoreKey({
            projectKey: "  Users-necmttn-Projects-ax  ",
            sessionId: "  9f8c1b34-5ff5-4c87-a6fb-cc9bb48ef567  ",
            subpath: ["subagents", "worker-1.jsonl"],
        });

        expect(key).toBe(
            '{"v":1,"projectKey":"Users-necmttn-Projects-ax","sessionId":"9f8c1b34-5ff5-4c87-a6fb-cc9bb48ef567","subpath":"subagents/worker-1.jsonl"}',
        );
        expect(parseAxSessionStoreKey(key)).toEqual({
            projectKey: "Users-necmttn-Projects-ax",
            sessionId: "9f8c1b34-5ff5-4c87-a6fb-cc9bb48ef567",
            subpath: "subagents/worker-1.jsonl",
        });
    });

    test("omits absent subpaths and keeps the same graph identity", () => {
        const key = axSessionStoreKey({
            projectKey: "Users-necmttn-Projects-ax",
            sessionId: "9f8c1b34-5ff5-4c87-a6fb-cc9bb48ef567",
        });

        expect(key).toBe(
            '{"v":1,"projectKey":"Users-necmttn-Projects-ax","sessionId":"9f8c1b34-5ff5-4c87-a6fb-cc9bb48ef567"}',
        );
        expect(parseAxSessionStoreKey(key)).toEqual({
            projectKey: "Users-necmttn-Projects-ax",
            sessionId: "9f8c1b34-5ff5-4c87-a6fb-cc9bb48ef567",
        });
    });

    test("rejects malformed JSON and non-object keys", () => {
        for (const key of ["", "{not-json", "null", '"string"', "[]", "42"]) {
            expect(() => parseAxSessionStoreKey(key)).toThrow(AxSessionStoreKeyError);
        }
    });

    test("rejects empty or invalid project/session components", () => {
        const invalidParts = [
            { projectKey: "", sessionId: "session-1" },
            { projectKey: "   ", sessionId: "session-1" },
            { projectKey: "project/one", sessionId: "session-1" },
            { projectKey: "project one", sessionId: "session-1" },
            { projectKey: "project\none", sessionId: "session-1" },
            { projectKey: "project-one", sessionId: "" },
            { projectKey: "project-one", sessionId: "session/1" },
            { projectKey: "project-one", sessionId: "session one" },
        ];

        for (const parts of invalidParts) {
            expect(() => axSessionStoreKey(parts)).toThrow(AxSessionStoreKeyError);
            expect(() => parseAxSessionStoreKey(JSON.stringify({ v: 1, ...parts }))).toThrow(
                AxSessionStoreKeyError,
            );
        }
    });

    test("rejects absolute, traversal, empty, and malformed subpaths", () => {
        const invalidSubpaths = [
            "",
            "   ",
            "/absolute",
            "\\absolute",
            "C:/absolute",
            "C:\\absolute",
            ".",
            "..",
            "./sidecar.jsonl",
            "../sidecar.jsonl",
            "sidecars/../sidecar.jsonl",
            "sidecars//sidecar.jsonl",
            "sidecars/",
            "sidecars\\sidecar.jsonl",
            "sidecars/bad name.jsonl",
            123,
            { nested: "sidecars/file.jsonl" },
        ];

        for (const subpath of invalidSubpaths) {
            expect(() =>
                axSessionStoreKey({
                    projectKey: "project-one",
                    sessionId: "session-1",
                    subpath: subpath as never,
                })
            ).toThrow(AxSessionStoreKeyError);
            expect(() =>
                parseAxSessionStoreKey(
                    JSON.stringify({
                        v: 1,
                        projectKey: "project-one",
                        sessionId: "session-1",
                        subpath,
                    }),
                )
            ).toThrow(AxSessionStoreKeyError);
        }
    });

    test("builds safe subpaths from explicit path segments", () => {
        expect(axSessionStoreSubpath("sidecars", "turn-0001.json")).toBe("sidecars/turn-0001.json");
        expect(() => axSessionStoreSubpath("sidecars", "..", "turn-0001.json")).toThrow(
            AxSessionStoreKeyError,
        );
    });
});

describe("Claude SDK append payloads", () => {
    test("converts SDK appends to claude provider events with sdk entrypoint labels", () => {
        const batch = claudeSdkAppendPayloadToAgentEventBatch({
            key: axSessionStoreKey({
                projectKey: "Users-necmttn-Projects-ax",
                sessionId: "9f8c1b34-5ff5-4c87-a6fb-cc9bb48ef567",
                subpath: "sidecars/assistant.jsonl",
            }),
            axSessionId: "9f8c1b34-5ff5-4c87-a6fb-cc9bb48ef567",
            cwd: "/Users/necmttn/Projects/ax",
            project: "ax",
            title: "Embedded Claude session",
            model: "claude-sonnet-4-5-20250929",
            labels: { entrypoint: "cli", app: "fixture" },
            sdkLanguage: "typescript",
            sdkName: "@anthropic-ai/sdk",
            sdkVersion: "1.2.3",
            sdkMetadata: { host: "unit-test" },
            events: [
                {
                    providerEventId: "evt-1",
                    seq: 1,
                    ts: "2026-06-18T00:00:01.000Z",
                    type: "message",
                    role: "user",
                    text: "hello",
                    labels: { entrypoint: "cli", turnKind: "prompt" },
                },
            ],
        });

        expect(batch.sessions).toEqual([
            {
                provider: "claude",
                providerSessionId: "9f8c1b34-5ff5-4c87-a6fb-cc9bb48ef567",
                axSessionId: "9f8c1b34-5ff5-4c87-a6fb-cc9bb48ef567",
                cwd: "/Users/necmttn/Projects/ax",
                project: "ax",
                title: "Embedded Claude session",
                model: "claude-sonnet-4-5-20250929",
                labels: {
                    app: "fixture",
                    entrypoint: "sdk",
                    sdkLanguage: "typescript",
                    sdkName: "@anthropic-ai/sdk",
                    sdkVersion: "1.2.3",
                    sdkMetadata: { host: "unit-test" },
                    sessionStore: {
                        projectKey: "Users-necmttn-Projects-ax",
                        subpath: "sidecars/assistant.jsonl",
                    },
                },
            },
        ]);
        expect(batch.events).toEqual([
            {
                provider: "claude",
                providerSessionId: "9f8c1b34-5ff5-4c87-a6fb-cc9bb48ef567",
                providerEventId: "evt-1",
                axSessionId: "9f8c1b34-5ff5-4c87-a6fb-cc9bb48ef567",
                seq: 1,
                ts: "2026-06-18T00:00:01.000Z",
                type: "message",
                role: "user",
                text: "hello",
                labels: {
                    turnKind: "prompt",
                    entrypoint: "sdk",
                },
            },
        ]);
    });

    test("builds append statements without clearing existing provider events", () => {
        const statements = buildClaudeSdkAppendStatements({
            key: {
                projectKey: "Users-necmttn-Projects-ax",
                sessionId: "9f8c1b34-5ff5-4c87-a6fb-cc9bb48ef567",
                subpath: "subagents/worker-1.jsonl",
            },
            events: [
                {
                    providerEventId: "worker-1-event-1",
                    seq: 1,
                    ts: "2026-06-18T00:00:01.000Z",
                    type: "message",
                },
            ],
        });
        const sql = statements.join("\n");

        expect(sql).toContain("UPSERT agent_session:");
        expect(sql).toContain("UPSERT agent_event:");
        expect(sql).not.toContain("DELETE (SELECT VALUE id FROM agent_event");
        expect(sql).not.toContain("DELETE (SELECT VALUE id FROM agent_event_child");
        expect(sql).toContain('\\"entrypoint\\":\\"sdk');
        expect(sql).toContain('\\"subpath\\":\\"subagents/worker-1.jsonl');
    });
});
