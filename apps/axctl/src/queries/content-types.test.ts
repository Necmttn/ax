import { describe, expect, test } from "bun:test";
import { rollupContentTypes, BYTES_PER_TOKEN } from "./content-types.ts";

describe("rollupContentTypes", () => {
  test("aggregates calls + bytes + token share by category", () => {
    const out = rollupContentTypes([
      { ct: "content_type:code", calls: 3, bytes: 400 },
      { ct: "content_type:text", calls: 1, bytes: 400 },
    ]);
    expect(out.rows).toEqual([
      { category: "code", calls: 3, bytes: 400, estTokens: 100, tokenShare: 0.5 },
      { category: "text", calls: 1, bytes: 400, estTokens: 100, tokenShare: 0.5 },
    ]);
    expect(out.totals).toEqual({ calls: 4, bytes: 800, estTokens: 200 });
  });

  test("sorts by est tokens desc and strips the content_type: prefix", () => {
    const out = rollupContentTypes([
      { ct: "content_type:text", calls: 1, bytes: 100 },
      { ct: "content_type:code", calls: 1, bytes: 900 },
    ]);
    expect(out.rows.map((r) => r.category)).toEqual(["code", "text"]);
  });

  test("BYTES_PER_TOKEN matches the context-budget ratio", () => {
    expect(BYTES_PER_TOKEN).toBe(4);
  });
});
