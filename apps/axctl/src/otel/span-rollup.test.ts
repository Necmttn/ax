import { describe, expect, test } from "bun:test";
import type { OtelSpanRow } from "./rows.ts";
import { rollupSpanLatencies } from "./span-rollup.ts";

const at = (ms: number): Date => new Date(Date.UTC(2026, 5, 17, 0, 0, 0, ms));

let nextSpanId = 0;
const span = (overrides: Partial<OtelSpanRow>): OtelSpanRow => ({
    harness: "claude",
    name: "unknown",
    trace_id: "trace-1",
    span_id: `span-${(nextSpanId += 1).toString(10)}`,
    parent_span_id: null,
    session_id: "session-1",
    started_at: at(0),
    ended_at: at(1),
    duration_ms: 1,
    attrs: null,
    observed_at: at(0),
    ...overrides,
});

describe("rollupSpanLatencies", () => {
    test("rolls Claude spans into prompt, model, tool, permission, hook, and subagent buckets", () => {
        const rows = rollupSpanLatencies([
            span({ name: "prompt", span_id: "prompt", duration_ms: 1000 }),
            span({ name: "api_request", span_id: "model", parent_span_id: "prompt", duration_ms: 400 }),
            span({ name: "tool_execution", span_id: "tool", parent_span_id: "prompt", duration_ms: 250 }),
            span({ name: "permission_wait", span_id: "perm", parent_span_id: "tool", duration_ms: 125 }),
            span({ name: "hook_execution", span_id: "hook", parent_span_id: "tool", duration_ms: 75 }),
            span({
                name: "anything",
                span_id: "child",
                parent_span_id: "prompt",
                duration_ms: 300,
                attrs: JSON.stringify({ "agent.type": "subagent" }),
            }),
        ]);

        expect(rows).toEqual([
            {
                sessionId: "session-1",
                spanCount: 6,
                promptWallMs: 1000,
                modelRequestMs: 400,
                toolExecutionMs: 250,
                permissionWaitMs: 125,
                hookExecutionMs: 75,
                subagentMs: 300,
                subagentMaxDepth: 1,
            },
        ]);
    });

    test("uses attrs aliases and ignores spans without session ids", () => {
        const rows = rollupSpanLatencies([
            span({
                session_id: null,
                name: "prompt",
                span_id: "ignored",
                duration_ms: 1000,
            }),
            span({
                name: "span",
                span_id: "request",
                duration_ms: 50,
                attrs: JSON.stringify({ "span.kind": "model_request" }),
            }),
            span({
                name: "span",
                span_id: "tool",
                duration_ms: 25,
                attrs: JSON.stringify({ type: "tool" }),
            }),
            span({
                name: "span",
                span_id: "bad-json",
                duration_ms: 10,
                attrs: "{",
            }),
        ]);

        expect(rows).toEqual([
            {
                sessionId: "session-1",
                spanCount: 3,
                promptWallMs: 0,
                modelRequestMs: 50,
                toolExecutionMs: 25,
                permissionWaitMs: 0,
                hookExecutionMs: 0,
                subagentMs: 0,
                subagentMaxDepth: 0,
            },
        ]);
    });

    test("recognizes planned Claude span names and reports only subagent nesting", () => {
        const rows = rollupSpanLatencies([
            span({ name: "claude_code.interaction", span_id: "interaction", duration_ms: 600 }),
            span({
                name: "blocked_on_user",
                span_id: "permission",
                parent_span_id: "interaction",
                duration_ms: 90,
            }),
            span({
                name: "hook_execution",
                span_id: "hook",
                parent_span_id: "permission",
                duration_ms: 20,
            }),
            span({
                name: "claude_code.subagent",
                span_id: "subagent-a",
                parent_span_id: "interaction",
                duration_ms: 200,
            }),
            span({
                name: "claude_code.subagent",
                span_id: "subagent-b",
                parent_span_id: "subagent-a",
                duration_ms: 100,
            }),
        ]);

        expect(rows).toEqual([
            {
                sessionId: "session-1",
                spanCount: 5,
                promptWallMs: 600,
                modelRequestMs: 0,
                toolExecutionMs: 0,
                permissionWaitMs: 90,
                hookExecutionMs: 20,
                subagentMs: 300,
                subagentMaxDepth: 2,
            },
        ]);
    });

    test("does not inflate subagent depth for self-parented or cyclic spans", () => {
        const rows = rollupSpanLatencies([
            span({
                name: "claude_code.subagent",
                span_id: "self",
                parent_span_id: "self",
                duration_ms: 10,
            }),
            span({
                name: "claude_code.subagent",
                span_id: "cycle-a",
                parent_span_id: "cycle-b",
                duration_ms: 10,
            }),
            span({
                name: "claude_code.subagent",
                span_id: "cycle-b",
                parent_span_id: "cycle-a",
                duration_ms: 10,
            }),
        ]);

        expect(rows[0]?.subagentMaxDepth).toBe(1);
    });

    test("resolves parent spans within the same trace only", () => {
        const rows = rollupSpanLatencies([
            span({
                trace_id: "trace-a",
                name: "claude_code.subagent",
                span_id: "shared",
                duration_ms: 50,
            }),
            span({
                trace_id: "trace-b",
                name: "claude_code.subagent",
                span_id: "child",
                parent_span_id: "shared",
                duration_ms: 25,
            }),
            span({
                trace_id: "trace-b",
                name: "claude_code.interaction",
                span_id: "shared",
                duration_ms: 100,
            }),
        ]);

        expect(rows[0]?.subagentMaxDepth).toBe(1);
    });

    test("avoids broad substring false positives", () => {
        const rows = rollupSpanLatencies([
            span({ name: "webhook_delivery", span_id: "webhook", duration_ms: 20 }),
            span({ name: "stool_sample_parser", span_id: "stool", duration_ms: 30 }),
        ]);

        expect(rows[0]?.hookExecutionMs).toBe(0);
        expect(rows[0]?.toolExecutionMs).toBe(0);
    });
});
