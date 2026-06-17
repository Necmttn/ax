import { describe, expect, test } from "bun:test";
import { buildContentEdge, renderContentEdge, renderContentTypeNodes, type ContentEdgeSpec, type ToolCallRow } from "./derive-content-types.ts";

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

describe("renderContentEdge", () => {
  test("emits a deterministic RELATE keyed by tool_call id (idempotent re-runs)", () => {
    const sql = renderContentEdge({
      toolCallId: "tool_call:abc", category: "code", session: "session:s1",
      method: "extension", confidence: 0.95, fineLabel: "ts", bytes: 12, ts: "2026-06-17T00:00:00Z",
    });
    expect(sql).toContain("->has_content:");
    expect(sql).toContain("->content_type:");
    expect(sql).toContain("bytes = 12");
    expect(sql).toContain("confidence = 0.95");
  });

  test("returns null on an unkeyable id", () => {
    expect(renderContentEdge({ toolCallId: "", category: "text" } as unknown as ContentEdgeSpec)).toBeNull();
  });
});

describe("renderContentTypeNodes", () => {
  test("upserts all 12 fixed category nodes", () => {
    const stmts = renderContentTypeNodes();
    expect(stmts.length).toBe(12);
    expect(stmts[0]).toContain("UPSERT content_type:");
  });
});

describe("renderContentEdge - collision resistance", () => {
  // Two tool_call ids that share more than 96 chars of common prefix (the old
  // safeKeyPart truncation limit) must still produce DIFFERENT edge keys so that
  // cursor/opencode ids from the same conversation never collide.
  test("two ids sharing a 100+ char prefix produce different has_content edge keys", () => {
    const base = "tool_call:" + "x".repeat(100);
    const spec = (id: string): ContentEdgeSpec => ({
      toolCallId: id,
      category: "text",
      session: "session:s1",
      method: "fallback",
      confidence: 0.5,
      fineLabel: null,
      bytes: 100,
      ts: "2026-06-17T00:00:00Z",
    });
    const sql1 = renderContentEdge(spec(base + "a"));
    const sql2 = renderContentEdge(spec(base + "b"));
    expect(sql1).not.toBeNull();
    expect(sql2).not.toBeNull();
    const key1 = sql1!.match(/->has_content:`([^`]+)`/)?.[1];
    const key2 = sql2!.match(/->has_content:`([^`]+)`/)?.[1];
    expect(key1).toBeDefined();
    expect(key2).toBeDefined();
    expect(key1).not.toBe(key2);
  });

  test("same id always produces the same edge key (idempotent re-runs)", () => {
    const row: ToolCallRow = {
      id: "tool_call:abc123", session: "session:s1", name: "Bash",
      inputJson: null, outputExcerpt: "hello", bytes: 5, ts: "2026-06-17T00:00:00Z",
    };
    const e = buildContentEdge(row);
    expect(renderContentEdge(e)).toBe(renderContentEdge(e));
  });
});
