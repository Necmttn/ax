import { describe, expect, it } from "bun:test";
import { invocationRowKey, parseUsageLog } from "./usage-stage.ts";
import { UsageRecord } from "./model.ts";

const rec = (over: Partial<ConstructorParameters<typeof UsageRecord>[0]> = {}) => UsageRecord.make({
  ts: new Date("2026-06-15T12:00:00Z"), command: "digest", flags: [], exit_code: 0,
  duration_ms: 5, origin: "agent", repo_key: "ax", ax_version: "0.29.0", ...over,
});

describe("parseUsageLog", () => {
  it("parses valid lines, skips malformed ones", () => {
    const text = [
      JSON.stringify({ ts: "2026-06-15T12:00:00.000Z", command: "digest", flags: [], exit_code: 0, duration_ms: 5, origin: "agent", repo_key: "ax", ax_version: "0.29.0" }),
      "GARBAGE",
      "",
    ].join("\n");
    const rows = parseUsageLog(text);
    expect(rows).toHaveLength(1);
    expect(rows[0].command).toBe("digest");
  });
});

describe("invocationRowKey", () => {
  it("is stable for the same (ts, command, repo_key, origin)", () => {
    expect(invocationRowKey(rec())).toBe(invocationRowKey(rec()));
  });
  it("differs when ts or command differs", () => {
    expect(invocationRowKey(rec())).not.toBe(invocationRowKey(rec({ command: "ingest" })));
    expect(invocationRowKey(rec())).not.toBe(invocationRowKey(rec({ ts: new Date("2026-06-15T13:00:00Z") })));
  });
});
