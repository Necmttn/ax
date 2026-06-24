import { describe, expect, test } from "bun:test";
import { mergeVerdicts } from "./merge-verdicts.ts";
import { Verdict } from "./verdict.ts";

describe("mergeVerdicts", () => {
  test("empty -> allow", () => {
    expect(mergeVerdicts([])).toEqual(Verdict.allow);
  });

  test("all allow -> allow", () => {
    expect(mergeVerdicts([Verdict.allow, Verdict.allow])).toEqual(Verdict.allow);
  });

  test("first block wins and short-circuits", () => {
    const merged = mergeVerdicts([
      Verdict.allow,
      Verdict.block("first reason"),
      Verdict.block("second reason"),
      Verdict.advise("ignored"),
    ]);
    expect(merged).toEqual(Verdict.block("first reason"));
  });

  test("block beats any advisory regardless of order", () => {
    const merged = mergeVerdicts([Verdict.advise("a"), Verdict.warn("w"), Verdict.block("no")]);
    expect(merged._tag).toBe("Block");
  });

  test("single advise passes through", () => {
    expect(mergeVerdicts([Verdict.allow, Verdict.advise("route down")])).toEqual(
      Verdict.advise("route down"),
    );
  });

  test("multiple same-kind advisories join with a blank line", () => {
    const merged = mergeVerdicts([Verdict.advise("one"), Verdict.advise("two")]);
    expect(merged).toEqual(Verdict.advise("one\n\ntwo"));
  });

  test("inject outranks advise and warn", () => {
    const merged = mergeVerdicts([Verdict.warn("w"), Verdict.advise("a"), Verdict.inject("ctx")]);
    expect(merged).toEqual(Verdict.inject("ctx"));
  });

  test("advise outranks warn", () => {
    const merged = mergeVerdicts([Verdict.warn("w"), Verdict.advise("a")]);
    expect(merged).toEqual(Verdict.advise("a"));
  });

  test("warn wins when it is the only advisory", () => {
    expect(mergeVerdicts([Verdict.allow, Verdict.warn("careful")])).toEqual(
      Verdict.warn("careful"),
    );
  });
});
