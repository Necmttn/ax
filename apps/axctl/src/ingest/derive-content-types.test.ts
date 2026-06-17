import { describe, expect, test } from "bun:test";
import { buildContentEdge, renderContentEdge, renderContentTypeNodes, type ContentEdgeSpec } from "./derive-content-types.ts";

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
