import { describe, expect, test } from "bun:test";
import {
    buildContentDocumentRows,
    contentAtomRecordKey,
    contentBlockRecordKey,
    contentDocumentRecordKey,
    contentParseFingerprint,
} from "./persist.ts";

const parsed = {
    parserId: "gsd-plan",
    parserVersion: "1.0.0",
    classifierVersions: { refs: "1.0.0" },
    blocks: [
        {
            kind: "frontmatter",
            seq: 1,
            text: "phase: 62",
            textExcerpt: "phase: 62",
            searchText: null,
            confidence: 1,
            parser: "gsd-plan",
        },
        {
            kind: "checklist_item",
            seq: 2,
            parentSeq: 1,
            text: "- [ ] Update src/auth/server.ts",
            textExcerpt: "- [ ] Update src/auth/server.ts",
            searchText: "- [ ] Update src/auth/server.ts",
            confidence: 0.9,
            parser: "gsd-plan",
        },
    ],
    atoms: [
        {
            blockSeq: 1,
            kind: "frontmatter_field",
            value: "phase=62",
            normalized: "phase",
            confidence: 1,
        },
        {
            blockSeq: 2,
            kind: "file_ref",
            value: "src/auth/server.ts",
            normalized: "src/auth/server.ts",
            confidence: 0.8,
        },
    ],
} as const;

describe("content block persistence statement builders", () => {
    test("record keys are source scoped and stable", () => {
        const documentKey = contentDocumentRecordKey("artifact", ".planning/62-PLAN.md");
        expect(documentKey).toBe(contentDocumentRecordKey("artifact", ".planning/62-PLAN.md"));
        expect(documentKey).toMatch(/^artifact__planning_62_PLAN_md__[0-9a-f]{16}$/);

        const blockKey = contentBlockRecordKey(documentKey, 2);
        expect(blockKey).toEndWith("__block_000002");
        expect(contentAtomRecordKey(blockKey, "file_ref", 1)).toContain("__file_ref__");
    });

    test("parse fingerprint changes with parser versions", () => {
        const first = contentParseFingerprint({
            contentHash: "hash-a",
            parsed,
        });
        const second = contentParseFingerprint({
            contentHash: "hash-a",
            parsed: { ...parsed, parserVersion: "1.0.1" },
        });
        expect(first).not.toBe(second);
    });

    test("builds document, block, and atom rows with query dimensions", () => {
        const rows = buildContentDocumentRows({
            sourceKind: "artifact",
            sourceRef: ".planning/62-PLAN.md",
            artifactId: "artifact-62",
            workspaceId: "workspace-1",
            artifactKind: "gsd_plan",
            path: ".planning/62-PLAN.md",
            title: "62 plan",
            contentHash: "hash-a",
            labels: { family: "gsd" },
            parsed,
        });

        const documentKey = contentDocumentRecordKey("artifact", ".planning/62-PLAN.md");
        expect(rows.document).toMatchObject({ id: documentKey, source_kind: "artifact", artifact: "artifact-62" });
        expect(rows.blocks).toHaveLength(2);
        expect(rows.blocks[1]).toMatchObject({ kind: "checklist_item", search_text: "- [ ] Update src/auth/server.ts" });
        expect(rows.atoms).toHaveLength(2);
        expect(rows.atoms[1]).toMatchObject({ kind: "file_ref", workspace: "workspace-1", artifact_kind: "gsd_plan" });
    });
});
