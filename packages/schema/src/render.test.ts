import { describe, expect, test } from "bun:test";
import schemaSurql from "./schema.surql" with { type: "text" };
import { renderBucketBackends } from "./render.ts";

describe("renderBucketBackends", () => {
    test("rewrites every DEFINE BUCKET backend to the given buckets dir", () => {
        const rendered = renderBucketBackends(schemaSurql, "/Users/alice/.local/share/ax/buckets");
        expect(rendered).toContain(
            `DEFINE BUCKET IF NOT EXISTS transcripts\n    BACKEND "file:/Users/alice/.local/share/ax/buckets/transcripts";`,
        );
        expect(rendered).toContain(
            `DEFINE BUCKET IF NOT EXISTS codex_artifacts\n    BACKEND "file:/Users/alice/.local/share/ax/buckets/codex_artifacts";`,
        );
        // no committed-machine path survives in any bucket backend
        for (const line of rendered.split("\n")) {
            if (line.includes('BACKEND "file:')) expect(line).toContain("/Users/alice/");
        }
    });

    test("rewrites all DEFINE BUCKET statements in the shipped schema", () => {
        const bucketCount = (schemaSurql.match(/DEFINE BUCKET IF NOT EXISTS/g) ?? []).length;
        expect(bucketCount).toBeGreaterThanOrEqual(2);
        const rendered = renderBucketBackends(schemaSurql, "/tmp/ax-buckets");
        const rewritten = (rendered.match(/BACKEND "file:\/tmp\/ax-buckets\//g) ?? []).length;
        expect(rewritten).toBe(bucketCount);
    });

    test("leaves non-bucket content untouched", () => {
        const rendered = renderBucketBackends(schemaSurql, "/tmp/ax-buckets");
        expect(rendered.split("\n").length).toBe(schemaSurql.split("\n").length);
        expect(rendered).toContain("DEFINE TABLE turn SCHEMAFULL;");
    });
});
