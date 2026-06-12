import { describe, expect, test } from "bun:test";
import { optionalNumberParam } from "./params.ts";

const url = (qs: string): URL => new URL(`http://h/api/x${qs}`);

describe("optionalNumberParam", () => {
    test("parses finite numbers", () => {
        expect(optionalNumberParam(url("?minCount=3"), "minCount")).toBe(3);
    });
    test("undefined when absent", () => {
        expect(optionalNumberParam(url(""), "minCount")).toBeUndefined();
    });
    test("undefined when empty", () => {
        expect(optionalNumberParam(url("?minCount="), "minCount")).toBeUndefined();
    });
    test("undefined when non-numeric", () => {
        expect(optionalNumberParam(url("?minCount=x"), "minCount")).toBeUndefined();
    });
});
