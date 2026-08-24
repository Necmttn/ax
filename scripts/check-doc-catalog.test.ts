import { describe, expect, test } from "bun:test";

import { DOC_STATES, type DocCatalog, validateDocCatalog } from "./check-doc-catalog.ts";

function catalog(overrides: Partial<DocCatalog> = {}): DocCatalog {
    return {
        version: 1,
        states: DOC_STATES,
        collectionDefaults: [{ prefix: "docs/history/", status: "historical" }],
        currentFiles: ["docs/current.md"],
        overrides: [],
        ...overrides,
    };
}

describe("validateDocCatalog", () => {
    test("accepts current files and collection defaults", () => {
        expect(validateDocCatalog(catalog(), ["docs/current.md", "docs/history/old.md"])).toEqual([]);
    });

    test("rejects files without a state", () => {
        expect(validateDocCatalog(catalog(), ["docs/current.md", "docs/unknown.md"])).toContain(
            "document has no state: docs/unknown.md",
        );
    });

    test("rejects overlapping defaults without an override", () => {
        const value = catalog({
            collectionDefaults: [
                { prefix: "docs/history/", status: "historical" },
                { prefix: "docs/history/old/", status: "evidence" },
            ],
        });
        expect(validateDocCatalog(value, ["docs/current.md", "docs/history/old/a.md"])).toContain(
            "document has overlapping defaults: docs/history/old/a.md",
        );
    });

    test("accepts a justified override across collection defaults", () => {
        const value = catalog({
            overrides: [{ path: "docs/history/index.md", status: "current", reason: "Index file." }],
        });
        expect(validateDocCatalog(value, ["docs/current.md", "docs/history/index.md"])).toEqual([]);
    });

    test("rejects unknown states and empty override reasons", () => {
        const value = catalog({
            overrides: [{ path: "docs/history/a.md", status: "live", reason: "" }],
        });
        expect(validateDocCatalog(value, ["docs/current.md", "docs/history/a.md"])).toEqual([
            "unknown state for docs/history/a.md: live",
            "override has no reason: docs/history/a.md",
        ]);
    });
});
