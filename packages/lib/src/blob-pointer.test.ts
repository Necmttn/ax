/**
 * The BlobPointer brand (#891): the three sanctioned operations round-trip,
 * and the structural guard keeps rejecting the shapes that caused the
 * confusion the brand exists to prevent (absolute filesystem paths).
 */
import { describe, expect, test } from "bun:test";
import {
    blobPointerBucket,
    blobPointerPath,
    filePointer,
    isBlobPointer,
} from "./blob-pointer.ts";

describe("blob-pointer", () => {
    test("filePointer output round-trips through the guard and the accessors", () => {
        const p = filePointer("transcripts", "abc-123.jsonl");
        // Widen for the literal comparison - the brand is nominal on purpose.
        expect(p as string).toBe("transcripts:/abc-123.jsonl");
        expect(isBlobPointer(p)).toBe(true);
        expect(blobPointerBucket(p)).toBe("transcripts");
        expect(blobPointerPath("/data/buckets", p)).toBe("/data/buckets/transcripts/abc-123.jsonl");
    });

    test("an absolute filesystem path is NOT a pointer", () => {
        expect(isBlobPointer("/Users/x/.claude/projects/-p/abc.jsonl")).toBe(false);
        expect(isBlobPointer("/tmp/whatever.jsonl")).toBe(false);
    });

    test("the guard narrows, so blobPointerPath only accepts guarded strings", () => {
        const value: string = "codex_artifacts:/r.jsonl";
        expect(isBlobPointer(value)).toBe(true);
        if (isBlobPointer(value)) {
            expect(blobPointerBucket(value)).toBe("codex_artifacts");
            expect(blobPointerPath("/d", value)).toBe("/d/codex_artifacts/r.jsonl");
        }
        // @ts-expect-error - an unguarded string is not a BlobPointer; this
        // compile error IS the feature (#891).
        blobPointerPath("/d", value);
    });

    test("empty and separator-bearing shapes stay rejected", () => {
        expect(isBlobPointer("")).toBe(false);
        expect(isBlobPointer("bucket://double")).toBe(false);
        expect(isBlobPointer("no-separator")).toBe(false);
    });
});
