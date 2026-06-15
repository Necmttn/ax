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

describe("encodeVerdict Route", () => {
  test("claude: emits permissionDecision allow + updatedInput", () => {
    const out = encodeVerdict(Verdict.route({ description: "Implement X", model: "sonnet" }), "claude");
    expect(out.exitCode).toBe(0);
    const json = JSON.parse(out.stdout!);
    expect(json.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { description: "Implement X", model: "sonnet" },
    });
  });
  test("codex: Route degrades to allow (no Agent dispatch / different protocol)", () => {
    const out = encodeVerdict(Verdict.route({ model: "sonnet" }), "codex");
    expect(out).toEqual({ exitCode: 0 });
  });
  test("claude: empty merge passes through as exactly {}", () => {
    const out = encodeVerdict(Verdict.route({}), "claude");
    expect(JSON.parse(out.stdout!).hookSpecificOutput.updatedInput).toEqual({});
  });
  test("claude: existing model passes through verbatim (dumb passthrough, no strip/override)", () => {
    const out = encodeVerdict(Verdict.route({ model: "opus", description: "x" }), "claude");
    expect(JSON.parse(out.stdout!).hookSpecificOutput.updatedInput).toEqual({ model: "opus", description: "x" });
  });
});
