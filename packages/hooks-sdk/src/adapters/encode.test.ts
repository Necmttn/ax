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

describe("encodeVerdict Advise", () => {
  test("claude: emits additionalContext JSON with the exact context string", () => {
    const msg = "this dispatch looks mechanical - re-dispatch with model:sonnet to save quota (conserve mode).";
    const out = encodeVerdict(Verdict.advise(msg), "claude");
    expect(out.exitCode).toBe(0);
    const json = JSON.parse(out.stdout!);
    expect(json.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      additionalContext: msg,
    });
  });
  test("codex: Advise degrades to allow (route-dispatch is claude-only; codex has no Agent dispatch)", () => {
    const out = encodeVerdict(Verdict.advise("some advice"), "codex");
    expect(out).toEqual({ exitCode: 0 });
  });
  test("claude: judgment catch-rate advisory encodes correctly", () => {
    const msg = "judgment work (review/design/audit) is the catch-rate gate - prefer the strong model (drop the cheap model: or set model:opus).";
    const out = encodeVerdict(Verdict.advise(msg), "claude");
    expect(out.exitCode).toBe(0);
    const json = JSON.parse(out.stdout!);
    expect(json.hookSpecificOutput.additionalContext).toBe(msg);
    expect(json.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  });
});
