import { describe, expect, it } from "bun:test";
import { rollup, type InvocationRow } from "./query.ts";

const row = (over: Partial<InvocationRow>): InvocationRow => ({
  ts: "2026-06-15T12:00:00.000Z", command: "digest", origin: "agent", exit_code: 0, ...over,
});

describe("rollup", () => {
  const visible = ["digest", "sessions", "recall", "quota", "thinking"];
  const rows: InvocationRow[] = [
    row({ command: "digest", ts: "2026-06-15T10:00:00.000Z" }),
    row({ command: "digest", ts: "2026-06-15T11:00:00.000Z", origin: "tty" }),
    row({ command: "sessions", ts: "2026-06-14T10:00:00.000Z" }),
    row({ command: "recall", ts: "2026-06-13T10:00:00.000Z", exit_code: 1 }),
  ];

  it("topCommands ranks by count desc with last_used", () => {
    const r = rollup(rows, visible);
    expect(r.topCommands[0]).toMatchObject({ command: "digest", count: 2 });
    expect(r.topCommands[0].last_used).toBe("2026-06-15T11:00:00.000Z");
  });
  it("activeDays counts distinct UTC days with >=1 run", () => {
    expect(rollup(rows, visible).activeDays).toBe(3);
  });
  it("unusedSurface = visible commands never invoked", () => {
    expect(rollup(rows, visible).unusedSurface.sort()).toEqual(["quota", "thinking"]);
  });
  it("originSplit counts agent vs tty", () => {
    expect(rollup(rows, visible).originSplit).toEqual({ agent: 3, tty: 1 });
  });
  it("reliability flags commands with a nonzero exit-rate", () => {
    const recall = rollup(rows, visible).reliability.find((x) => x.command === "recall");
    expect(recall?.failureRate).toBeCloseTo(1, 5);
  });
  it("empty rows -> empty rollup, all visible commands unused", () => {
    const r = rollup([], visible);
    expect(r.topCommands).toEqual([]);
    expect(r.activeDays).toBe(0);
    expect(r.unusedSurface.sort()).toEqual([...visible].sort());
  });
});
