import { describe, expect, test } from "bun:test";
import {
    buildContentDocumentStatements,
    buildMentionsFileStatement,
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

    test("writes document, block, and atom rows with query dimensions", () => {
        const statements = buildContentDocumentStatements({
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

        const sql = statements.join("\n");
        const documentKey = contentDocumentRecordKey("artifact", ".planning/62-PLAN.md");
        const blockKey = contentBlockRecordKey(documentKey, 2);

        expect(statements[0]).toBe(`DELETE content_atom WHERE document = content_document:\`${documentKey}\`;`);
        expect(statements[1]).toBe(`DELETE content_block WHERE document = content_document:\`${documentKey}\`;`);
        expect(sql).toContain(`UPSERT content_document:\`${documentKey}\` CONTENT`);
        expect(sql).toContain("source_kind: \"artifact\"");
        expect(sql).toContain("artifact: artifact:`artifact-62`");
        expect(sql).toContain("parse_fingerprint:");
        expect(sql).toContain("registry_version: \"content-blocks-v1\"");
        expect(sql).toContain("classifier_versions: \"{\\\"refs\\\":\\\"1.0.0\\\"}\"");
        expect(sql).toContain("ts: time::now()");
        expect(sql).toContain(`UPSERT content_block:\`${blockKey}\` CONTENT`);
        expect(sql).toContain("search_text: \"- [ ] Update src/auth/server.ts\"");
        expect(sql).toContain("block_hash:");
        expect(sql).toContain("UPSERT content_atom:");
        expect(sql).toContain("workspace: workspace:`workspace-1`");
        expect(sql).toContain("artifact_kind: \"gsd_plan\"");
        expect(sql).toContain("kind: \"file_ref\"");
    });

    test("writes explicit atom relation statements", () => {
        const documentKey = contentDocumentRecordKey("artifact", ".planning/62-PLAN.md");
        const blockKey = contentBlockRecordKey(documentKey, 2);
        const atomKey = contentAtomRecordKey(blockKey, "file_ref", 1);

        const sql = buildMentionsFileStatement({
            atomKey,
            blockKey,
            documentKey,
            sourceKind: "artifact",
            workspaceId: "workspace-1",
            targetKey: "repo__src_auth_server_ts",
            confidence: 0.8,
        });

        expect(sql).toContain(`RELATE content_atom:\`${atomKey}\`->mentions_file:\``);
        expect(sql).toContain("->file:`repo__src_auth_server_ts`");
        expect(sql).toContain(`document = content_document:\`${documentKey}\``);
        expect(sql).toContain(`block = content_block:\`${blockKey}\``);
        expect(sql).toContain("confidence = 0.8");
        expect(sql).toContain("workspace = workspace:`workspace-1`");
    });
});
