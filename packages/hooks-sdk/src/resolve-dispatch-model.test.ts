import { describe, expect, it } from "bun:test";
import { resolveDispatchModel } from "./resolve-dispatch-model.ts";
import { DEFAULT_ROUTING_TABLE } from "./routing-table.ts";

const T = DEFAULT_ROUTING_TABLE;

describe("resolveDispatchModel", () => {
  it("route-down: mechanical impl description → sonnet", () => {
    const r = resolveDispatchModel(T, "implement the parser toolkit", null);
    expect(r.tier).toBe("route-down");
    expect(r.judgmentStrong).toBe(false);
    expect(r.effectiveModel).toBe("sonnet");
    expect(r.match?.classId).toBe("well-specified-impl");
  });

  it("judgment: a review description → keep strong (effectiveModel null)", () => {
    const r = resolveDispatchModel(T, "PR review of the auth module", null);
    expect(r.tier).toBe("judgment");
    expect(r.judgmentStrong).toBe(true);
    expect(r.effectiveModel).toBeNull();
  });

  it("judgment beats route-down: description matches BOTH a class and judgment", () => {
    const r = resolveDispatchModel(T, "implement design review feedback", null);
    expect(r.tier).toBe("judgment");
    expect(r.judgmentStrong).toBe(true);
    expect(r.effectiveModel).toBeNull();
    expect(r.match).not.toBeNull();
  });

  it("inherit: no class, not judgment → keep inherited (null)", () => {
    const r = resolveDispatchModel(T, "ponder the meaning of the codebase", null);
    expect(r.tier).toBe("inherit");
    expect(r.judgmentStrong).toBe(false);
    expect(r.effectiveModel).toBeNull();
    expect(r.match).toBeNull();
  });

  it("agent-type route-down: Explore → haiku via agentTypes", () => {
    const r = resolveDispatchModel(T, "anything", "Explore");
    expect(r.tier).toBe("route-down");
    expect(r.effectiveModel).toBe("haiku");
    expect(r.match?.source).toBe("agentType");
  });

  it("null/empty description → inherit, no throw", () => {
    expect(resolveDispatchModel(T, null, null).tier).toBe("inherit");
    expect(resolveDispatchModel(T, "", null).tier).toBe("inherit");
    expect(resolveDispatchModel(T, undefined, undefined).tier).toBe("inherit");
  });
});
