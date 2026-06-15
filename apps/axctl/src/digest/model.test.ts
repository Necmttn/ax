import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { DigestItem, DigestSnapshot, decodeSnapshotOrNull } from "./model.ts";

describe("digest model", () => {
  it("encodes + decodes a DigestItem round-trip", () => {
    const item = DigestItem.make({
      id: "cost:routing",
      kind: "cost",
      salience: 0.74,
      text: "routing could save ~$42/wk (38% inherit)",
      action: "ax dispatches --candidates",
      evidence: undefined,
      computed_at: new Date("2026-06-15T00:00:00Z"),
    });
    const encoded = Schema.encodeSync(DigestItem)(item);
    const decoded = Schema.decodeUnknownSync(DigestItem)(encoded);
    expect(decoded.id).toBe("cost:routing");
    expect(decoded.kind).toBe("cost");
  });

  it("decodeSnapshotOrNull returns null on garbage, snapshot on valid JSON", () => {
    expect(decodeSnapshotOrNull("not json")).toBeNull();
    expect(decodeSnapshotOrNull(JSON.stringify({ nope: true }))).toBeNull();
    const snap = DigestSnapshot.make({
      generated_at: new Date("2026-06-15T00:00:00Z"),
      window_days: 14,
      items: [],
    });
    const text = JSON.stringify(Schema.encodeSync(DigestSnapshot)(snap));
    expect(decodeSnapshotOrNull(text)?.window_days).toBe(14);
  });

  it("decodeSnapshotOrNull returns null on a structurally-valid snapshot with a garbage date", () => {
    expect(
      decodeSnapshotOrNull(
        JSON.stringify({ generated_at: "not-a-date", window_days: 7, items: [] }),
      ),
    ).toBeNull();
  });
});
