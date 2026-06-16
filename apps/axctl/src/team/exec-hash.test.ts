import { describe, expect, it } from "bun:test";
import { sha256Hex } from "./exec-hash.ts";

describe("sha256Hex", () => {
  it("is the known sha256 of a string", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("changes with content", () => {
    expect(sha256Hex("a")).not.toBe(sha256Hex("b"));
  });
});
