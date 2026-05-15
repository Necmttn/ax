import { describe, expect, test } from "bun:test";
import { classifyToolFileEvidence, evidenceReason } from "./tool-file-evidence.ts";

describe("tool file evidence classification", () => {
    test("classifies file read tools and shell readers", () => {
        expect(classifyToolFileEvidence({ name: "Read" })).toEqual(["read_file"]);
        expect(classifyToolFileEvidence({ name: "exec_command", commandNorm: "sed" })).toEqual(["read_file"]);
        expect(evidenceReason({ name: "exec_command", commandNorm: "sed" }, "read_file")).toBe("command_norm:sed");
    });

    test("classifies search tools and shell search commands", () => {
        expect(classifyToolFileEvidence({ name: "Grep" })).toEqual(["searched_file"]);
        expect(classifyToolFileEvidence({ name: "Bash", commandNorm: "rg" })).toEqual(["searched_file"]);
        expect(evidenceReason({ name: "Bash", commandNorm: "rg" }, "searched_file")).toBe("command_norm:rg");
    });

    test("ignores unrelated commands", () => {
        expect(classifyToolFileEvidence({ name: "exec_command", commandNorm: "git status" })).toEqual([]);
    });
});
