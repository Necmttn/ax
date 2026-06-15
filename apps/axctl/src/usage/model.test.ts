import { describe, expect, it } from "bun:test";
import { UsageRecord, parseUsageLine, encodeUsageLine } from "./model.ts";

const rec = () => UsageRecord.make({
  ts: new Date("2026-06-15T12:00:00Z"),
  command: "sessions churn",
  flags: ["--here", "--json"],
  exit_code: 0,
  duration_ms: 1200,
  origin: "agent",
  repo_key: "ax",
  ax_version: "0.29.0",
});

describe("usage model", () => {
  it("encodeUsageLine -> parseUsageLine round-trips", () => {
    const line = encodeUsageLine(rec());
    expect(line.endsWith("\n")).toBe(false);
    const back = parseUsageLine(line);
    expect(back?.command).toBe("sessions churn");
    expect(back?.flags).toEqual(["--here", "--json"]);
    expect(back?.origin).toBe("agent");
  });
  it("parseUsageLine returns null on malformed / non-JSON / bad-shape lines", () => {
    expect(parseUsageLine("not json")).toBeNull();
    expect(parseUsageLine(JSON.stringify({ nope: 1 }))).toBeNull();
    expect(parseUsageLine("")).toBeNull();
  });
  it("repo_key is optional (null outside a repo)", () => {
    const r = UsageRecord.make({ ...rec(), repo_key: null });
    const back = parseUsageLine(encodeUsageLine(r));
    expect(back?.repo_key).toBeNull();
  });
});
