import { describe, expect, test } from "bun:test";
import { encodeVerdict } from "./encode.ts";
import { Verdict } from "../verdict.ts";

describe("encodeVerdict", () => {
  test("allow → exit 0, no output", () => {
    expect(encodeVerdict(Verdict.allow, "claude")).toEqual({ exitCode: 0 });
  });
  test("block → exit 2 + reason on stderr (both harnesses)", () => {
    expect(encodeVerdict(Verdict.block("BLOCKED: x"), "claude")).toEqual({ exitCode: 2, stderr: "BLOCKED: x" });
    expect(encodeVerdict(Verdict.block("BLOCKED: x"), "codex")).toEqual({ exitCode: 2, stderr: "BLOCKED: x" });
  });
  test("warn → systemMessage JSON on stdout, exit 0", () => {
    expect(encodeVerdict(Verdict.warn("careful"), "claude")).toEqual({
      exitCode: 0,
      stdout: JSON.stringify({ systemMessage: "careful" }),
    });
  });
  test("inject → plain stdout, exit 0", () => {
    expect(encodeVerdict(Verdict.inject("ctx"), "claude")).toEqual({ exitCode: 0, stdout: "ctx" });
  });
});
