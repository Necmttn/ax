import { describe, expect, test } from "bun:test";
import { Result, Schema } from "effect";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_ROUTING_TABLE,
  RoutingTableSchema,
  loadRoutingTableOrDefault,
  parseStoredRoutingTable,
  readRoutingTableSync,
} from "./routing-table.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "ax-routing-table-"));

const validTable = {
  version: 1,
  classes: [
    { id: "spec-review", pattern: "^spec review", flags: "i", suggest: "sonnet", reason: "x" },
  ],
  agentTypes: { Explore: "haiku" },
};

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe("RoutingTableSchema", () => {
  const decode = Schema.decodeUnknownResult(RoutingTableSchema);

  test("accepts origin-tagged classes written by ax routing compile/tune", () => {
    const result = decode({
      version: 1,
      classes: [
        { ...validTable.classes[0], origin: "default" },
        { id: "mined", pattern: "^summarize", flags: "i", suggest: "haiku", reason: "y", origin: "user" },
      ],
      agentTypes: { Explore: "haiku" },
    });
    expect(Result.isSuccess(result)).toBe(true);
  });

  test("decodes a legacy origin-less table without agentTypes", () => {
    const result = decode({ version: 1, classes: validTable.classes });
    expect(Result.isSuccess(result)).toBe(true);
  });

  test("tolerates unknown origin values (must not revert table to defaults)", () => {
    const result = decode({
      version: 1,
      classes: [{ id: "mined", pattern: "^summarize", suggest: "haiku", reason: "y", origin: "mined" }],
    });
    expect(Result.isSuccess(result)).toBe(true);
  });

  test("rejects a wrong version", () => {
    const result = decode({ version: 2, classes: [] });
    expect(Result.isSuccess(result)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fire-path sync read (whole-table fail-open)
// ---------------------------------------------------------------------------

describe("readRoutingTableSync", () => {
  test("reads and decodes a valid file", () => {
    const p = join(tmp(), "routing-table.json");
    writeFileSync(p, JSON.stringify(validTable));
    const table = readRoutingTableSync(p);
    expect(table).not.toBeNull();
    expect(table!.classes[0]!.id).toBe("spec-review");
  });

  test("missing file → null", () => {
    expect(readRoutingTableSync(join(tmp(), "absent.json"))).toBeNull();
  });

  test("corrupt JSON → null", () => {
    const p = join(tmp(), "bad.json");
    writeFileSync(p, "{not json");
    expect(readRoutingTableSync(p)).toBeNull();
  });

  test("schema mismatch → null (whole-table semantics, not row-dropping)", () => {
    const p = join(tmp(), "mismatch.json");
    writeFileSync(p, JSON.stringify({ version: 1, classes: [{ id: 42 }] }));
    expect(readRoutingTableSync(p)).toBeNull();
  });
});

describe("loadRoutingTableOrDefault", () => {
  test("falls back to DEFAULT_ROUTING_TABLE when the file is absent", () => {
    const table = loadRoutingTableOrDefault(join(tmp(), "absent.json"));
    expect(table).toBe(DEFAULT_ROUTING_TABLE);
  });

  test("returns the stored table when valid", () => {
    const p = join(tmp(), "routing-table.json");
    writeFileSync(p, JSON.stringify(validTable));
    const table = loadRoutingTableOrDefault(p);
    expect(table.classes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Compile-side normalize (row-level dropping)
// ---------------------------------------------------------------------------

describe("parseStoredRoutingTable", () => {
  test("normalizes: malformed rows dropped, missing agentTypes becomes {}", () => {
    const text = JSON.stringify({
      version: 1,
      classes: [validTable.classes[0], { id: 42 }],
    });
    const loaded = parseStoredRoutingTable(text);
    expect(loaded).not.toBeNull();
    expect(loaded!.classes).toHaveLength(1);
    expect(loaded!.agentTypes).toEqual({});
  });

  test("missing flags defaults to empty string; unknown origin dropped", () => {
    const text = JSON.stringify({
      version: 1,
      classes: [{ id: "a", pattern: "^a", suggest: "haiku", reason: "r", origin: "mined" }],
    });
    const loaded = parseStoredRoutingTable(text);
    expect(loaded!.classes[0]!.flags).toBe("");
    expect(loaded!.classes[0]!.origin).toBeUndefined();
  });

  test("preserves default/user origin tags", () => {
    const text = JSON.stringify({
      version: 1,
      classes: [
        { id: "a", pattern: "^a", flags: "i", suggest: "haiku", reason: "r", origin: "default" },
        { id: "b", pattern: "^b", flags: "i", suggest: "sonnet", reason: "r", origin: "user" },
      ],
    });
    const loaded = parseStoredRoutingTable(text);
    expect(loaded!.classes.map((c) => c.origin)).toEqual(["default", "user"]);
  });

  test("bad top-level shape → null (callers refuse to overwrite)", () => {
    expect(parseStoredRoutingTable("{not json")).toBeNull();
    expect(parseStoredRoutingTable(JSON.stringify({ version: 2, classes: [] }))).toBeNull();
    expect(parseStoredRoutingTable(JSON.stringify({ version: 1, classes: "nope" }))).toBeNull();
  });

  test("non-string agentTypes values are filtered out", () => {
    const text = JSON.stringify({
      version: 1,
      classes: [],
      agentTypes: { Explore: "haiku", broken: 3 },
    });
    const loaded = parseStoredRoutingTable(text);
    expect(loaded!.agentTypes).toEqual({ Explore: "haiku" });
  });
});
