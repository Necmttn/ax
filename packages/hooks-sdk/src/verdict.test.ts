import { describe, expect, test } from "bun:test";
import { Verdict } from "./verdict.ts";

describe("Verdict", () => {
  test("block carries reason", () => {
    const v = Verdict.block("nope");
    expect(v._tag).toBe("Block");
    expect(v._tag === "Block" && v.reason).toBe("nope");
  });
  test("allow is a singleton tag", () => {
    expect(Verdict.allow._tag).toBe("Allow");
  });
});
