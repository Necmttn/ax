import { describe, expect, test } from "bun:test";
import { buildContentEdge, contentEdgeRow, contentTypeRows, type ToolCallRow } from "./derive-content-types.ts";

describe("buildContentEdge", () => {
  test("derives category + denormalized session/bytes from a tool_call row", () => {
    const e = buildContentEdge({
      id: "tool_call:abc", session: "session:s1", name: "Read",
      inputJson: '{"file_path":"/x/y.ts"}', outputExcerpt: "const a = 1;", bytes: 12, ts: "2026-06-17T00:00:00Z",
    });
    expect(e).toEqual({
      toolCallId: "tool_call:abc", category: "code", session: "session:s1",
      method: "extension", confidence: 0.95, fineLabel: "ts", bytes: 12, ts: "2026-06-17T00:00:00Z",
    });
  });

  test("falls back to output sniff when input has no file_path", () => {
    const e = buildContentEdge({
      id: "tool_call:b", session: "session:s1", name: "Bash",
      inputJson: '{"command":"ls"}', outputExcerpt: '[{"a":1}]', bytes: 9, ts: "2026-06-17T00:00:00Z",
    });
    expect(e.category).toBe("json");
    expect(e.method).toBe("sniff");
  });
});

describe("contentEdgeRow", () => {
  test("builds a deterministic edge row", () => {
    const row = contentEdgeRow({
      toolCallId: "tool_call:abc", category: "code", session: "session:s1",
      method: "extension", confidence: 0.95, fineLabel: "ts", bytes: 12, ts: "2026-06-17T00:00:00Z",
    });
    expect(row).toMatchObject({ in_id: "tool_call:abc", out_id: "code", bytes: 12, confidence: 0.95 });
  });
});

describe("contentTypeRows", () => {
  test("builds all 12 fixed category nodes", () => {
    const rows = contentTypeRows();
    expect(rows.length).toBe(12);
    expect(rows[0]).toHaveProperty("category");
  });
});

describe("contentEdgeRow collision resistance", () => {
  // Two tool_call ids that share more than 96 chars of common prefix (the old
  // safeKeyPart truncation limit) must still produce DIFFERENT edge keys so that
  // cursor/opencode ids from the same conversation never collide.
  test("two ids sharing a 100+ char prefix produce different has_content edge keys", () => {
    const base = "tool_call:" + "x".repeat(100);
    const spec = (id: string) => ({
      toolCallId: id,
      category: "text" as const,
      session: "session:s1",
      method: "fallback",
      confidence: 0.5,
      fineLabel: null,
      bytes: 100,
      ts: "2026-06-17T00:00:00Z",
    });
    expect(contentEdgeRow(spec(base + "a")).id).not.toBe(contentEdgeRow(spec(base + "b")).id);
  });

  test("same id always produces the same edge key (idempotent re-runs)", () => {
    const row: ToolCallRow = {
      id: "tool_call:abc123", session: "session:s1", name: "Bash",
      inputJson: null, outputExcerpt: "hello", bytes: 5, ts: "2026-06-17T00:00:00Z",
    };
    const e = buildContentEdge(row);
    expect(contentEdgeRow(e)).toEqual(contentEdgeRow(e));
  });
});
