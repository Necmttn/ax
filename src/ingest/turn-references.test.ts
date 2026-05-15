import { describe, expect, test } from "bun:test";
import {
    classifySymbolKind,
    extractTurnReferences,
    normalizeErrorSignature,
} from "./turn-references.ts";

describe("turn reference extraction", () => {
    test("extracts file, symbol, and error references from a bug prompt", () => {
        const refs = extractTurnReferences(
            'Bug: "Working memory not initialized" from update_working_memory; WorkingMemoryProcessor tool handler cannot see WorkingMemoryMetadataRef in apps/nokta/app/processors/working-memory.ts',
        );

        expect(refs.files).toEqual(["apps/nokta/app/processors/working-memory.ts"]);
        expect(refs.symbols).toEqual([
            "update_working_memory",
            "WorkingMemoryMetadataRef",
            "WorkingMemoryProcessor",
        ]);
        expect(refs.errors).toEqual(["Working memory not initialized"]);
    });

    test("normalizes volatile error signatures", () => {
        expect(normalizeErrorSignature("TypeError: failed at line 42 in 0xabc123"))
            .toBe("typeerror: failed at line <num> in <hex>");
    });

    test("classifies basic symbol shapes", () => {
        expect(classifySymbolKind("WorkingMemoryProcessor")).toBe("camel");
        expect(classifySymbolKind("update_working_memory")).toBe("snake");
        expect(classifySymbolKind("renderContext")).toBe("function");
    });

    test("extracts references from command and tool output text", () => {
        const refs = extractTurnReferences([
            "rg -n WorkingMemoryProcessor apps/nokta/app/processors/working-memory.ts",
            "TypeError: Working memory not initialized at line 42",
        ].join("\n"));

        expect(refs.files).toEqual(["apps/nokta/app/processors/working-memory.ts"]);
        expect(refs.symbols).toContain("WorkingMemoryProcessor");
        expect(refs.errors).toEqual(["TypeError: Working memory not initialized at line 42"]);
    });
});
