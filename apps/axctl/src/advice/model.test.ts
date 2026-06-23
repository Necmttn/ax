import { describe, expect, it } from "bun:test";
import {
  parseSuggestedModel,
  normalizeTier,
  followedAdvice,
  parseAdviceLine,
  parseAdviceLog,
  adviceRowKey,
} from "./model.ts";

describe("parseSuggestedModel", () => {
  it("pulls the tier out of a route-dispatch advice string", () => {
    expect(parseSuggestedModel("this dispatch looks mechanical - re-dispatch with model:sonnet to save quota.")).toBe("sonnet");
  });
  it("handles hyphenated model ids", () => {
    expect(parseSuggestedModel("use model:gpt-5-mini here")).toBe("gpt-5-mini");
  });
  it("null advice / no model token -> null", () => {
    expect(parseSuggestedModel(null)).toBeNull();
    expect(parseSuggestedModel("no suggestion here")).toBeNull();
  });
});

describe("normalizeTier", () => {
  it("maps concrete ids to tiers", () => {
    expect(normalizeTier("claude-sonnet-4-6")).toBe("sonnet");
    expect(normalizeTier("claude-opus-4-8")).toBe("opus");
    expect(normalizeTier("claude-haiku-4-5-20251001")).toBe("haiku");
    expect(normalizeTier("claude-fable-5")).toBe("fable");
    expect(normalizeTier("gpt-5-mini")).toBe("gpt-5-mini");
  });
  it("null/undefined -> null", () => {
    expect(normalizeTier(null)).toBeNull();
    expect(normalizeTier(undefined)).toBeNull();
  });
});

describe("followedAdvice", () => {
  it("exact tier match -> followed", () => {
    expect(followedAdvice("sonnet", "claude-sonnet-4-6")).toBe(true);
  });
  it("advised sonnet, ran haiku (still off frontier) -> followed in spirit", () => {
    expect(followedAdvice("sonnet", "claude-haiku-4-5")).toBe(true);
  });
  it("advised sonnet, stayed on opus -> not followed", () => {
    expect(followedAdvice("sonnet", "claude-opus-4-8")).toBe(false);
  });
  it("advised sonnet, stayed on fable -> not followed", () => {
    expect(followedAdvice("sonnet", "claude-fable-5")).toBe(false);
  });
  it("null suggested or child -> null (unjudgeable)", () => {
    expect(followedAdvice(null, "claude-opus-4-8")).toBeNull();
    expect(followedAdvice("sonnet", null)).toBeNull();
  });
});

describe("parseAdviceLine", () => {
  const advised = JSON.stringify({
    ts: "2026-06-23T01:55:51.616Z",
    session_id: "demo-sess-abc123",
    tool: "Agent",
    description: "implement resolveSkillSparTask with TDD",
    injected: "this dispatch looks mechanical - re-dispatch with model:sonnet to save quota.",
    verdict: "advise",
  });

  it("parses an advise row with suggested model", () => {
    const r = parseAdviceLine(advised)!;
    expect(r.sessionId).toBe("demo-sess-abc123");
    expect(r.verdict).toBe("advise");
    expect(r.suggestedModel).toBe("sonnet");
    expect(r.description).toBe("implement resolveSkillSparTask with TDD");
    expect(r.ts.toISOString()).toBe("2026-06-23T01:55:51.616Z");
  });

  it("parses an allow row (no injection)", () => {
    const r = parseAdviceLine(JSON.stringify({ ts: "2026-06-23T01:55:51.684Z", session_id: "s", injected: null, verdict: "allow" }))!;
    expect(r.verdict).toBe("allow");
    expect(r.adviceText).toBeNull();
    expect(r.suggestedModel).toBeNull();
  });

  it("derives verdict from injected when absent", () => {
    const r = parseAdviceLine(JSON.stringify({ ts: "2026-06-23T01:55:51.684Z", session_id: "s", injected: "use model:haiku" }))!;
    expect(r.verdict).toBe("advise");
    expect(r.suggestedModel).toBe("haiku");
  });

  it("drops blank / malformed / unlinkable rows", () => {
    expect(parseAdviceLine("")).toBeNull();
    expect(parseAdviceLine("not json")).toBeNull();
    expect(parseAdviceLine(JSON.stringify({ ts: "2026-06-23T01:55:51Z" }))).toBeNull(); // no session_id
    expect(parseAdviceLine(JSON.stringify({ session_id: "s" }))).toBeNull(); // no ts
    expect(parseAdviceLine(JSON.stringify({ ts: "garbage", session_id: "s" }))).toBeNull(); // bad ts
  });
});

describe("parseAdviceLog + adviceRowKey", () => {
  it("parses multiple lines, skipping blanks", () => {
    const log = [
      JSON.stringify({ ts: "2026-06-23T01:00:00Z", session_id: "a", injected: "model:sonnet", verdict: "advise" }),
      "",
      JSON.stringify({ ts: "2026-06-23T01:01:00Z", session_id: "b", injected: null, verdict: "allow" }),
    ].join("\n");
    expect(parseAdviceLog(log)).toHaveLength(2);
  });

  it("row key is stable + collision-distinct on session/ts/description", () => {
    const r = parseAdviceLine(JSON.stringify({ ts: "2026-06-23T01:00:00Z", session_id: "a", description: "x", injected: "model:sonnet" }))!;
    const same = parseAdviceLine(JSON.stringify({ ts: "2026-06-23T01:00:00Z", session_id: "a", description: "x", injected: "model:sonnet" }))!;
    const diff = parseAdviceLine(JSON.stringify({ ts: "2026-06-23T01:00:00Z", session_id: "a", description: "y", injected: "model:sonnet" }))!;
    expect(adviceRowKey(r)).toBe(adviceRowKey(same));
    expect(adviceRowKey(r)).not.toBe(adviceRowKey(diff));
  });
});
