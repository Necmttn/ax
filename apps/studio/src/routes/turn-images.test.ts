import { describe, expect, test } from "bun:test";
import { extractImagePaths, isPureImageAttachment } from "./turn-images.ts";

describe("extractImagePaths", () => {
    test("extracts a single absolute image path", () => {
        const text = "[Image: source: /Users/x/shot.png]";
        expect(extractImagePaths(text)).toEqual(["/Users/x/shot.png"]);
    });

    test("extracts multiple image paths in order", () => {
        const text =
            "first [Image: source: /a/one.png] then [Image: source: /b/two.jpg]";
        expect(extractImagePaths(text)).toEqual(["/a/one.png", "/b/two.jpg"]);
    });

    test("handles spaces in the filename (CleanShot)", () => {
        const path =
            "/Users/necmttn/Library/Application Support/CleanShot/media/media_Bncog6hcRG/CleanShot 2026-06-09 at 10.00.51@2x.png";
        expect(extractImagePaths(`[Image: source: ${path}]`)).toEqual([path]);
    });

    test("ignores bare `[Image #N]` markers (no path)", () => {
        expect(extractImagePaths("[Image #1] some text [Image #2]")).toEqual([]);
    });

    test("ignores a source ref whose path is not an image extension", () => {
        expect(extractImagePaths("[Image: source: /etc/passwd]")).toEqual([]);
        expect(extractImagePaths("[Image: source: /a/notes.txt]")).toEqual([]);
    });

    test("mixed: pulls the resolvable ref, skips the bare marker", () => {
        const text = "[Image #1] question\n[Image: source: /a/shot.webp]";
        expect(extractImagePaths(text)).toEqual(["/a/shot.webp"]);
    });

    test("empty / no refs returns empty array", () => {
        expect(extractImagePaths("")).toEqual([]);
        expect(extractImagePaths("no images here")).toEqual([]);
    });

    test("extension match is case-insensitive", () => {
        expect(extractImagePaths("[Image: source: /a/SHOT.PNG]")).toEqual([
            "/a/SHOT.PNG",
        ]);
    });
});

describe("isPureImageAttachment", () => {
    test("a lone `[Image: source: …]` ref is pure", () => {
        expect(isPureImageAttachment("[Image: source: /a/shot.png]")).toBe(true);
    });

    test("whitespace around a lone ref is still pure", () => {
        expect(isPureImageAttachment("\n  [Image: source: /a/shot.png]  \n")).toBe(true);
    });

    test("multiple refs with only whitespace between are pure", () => {
        expect(
            isPureImageAttachment("[Image: source: /a/one.png]\n[Image: source: /b/two.jpg]"),
        ).toBe(true);
    });

    test("a ref with surrounding prose is NOT pure", () => {
        expect(
            isPureImageAttachment("Can we have alternative tool repr? [Image: source: /a/shot.png]"),
        ).toBe(false);
    });

    test("text with no renderable source ref is NOT pure", () => {
        expect(isPureImageAttachment("[Image #1] Can we have alternative tool repr?")).toBe(false);
        expect(isPureImageAttachment("just prose")).toBe(false);
        expect(isPureImageAttachment("")).toBe(false);
    });

    test("a non-image source ref is NOT pure (residual text survives)", () => {
        expect(isPureImageAttachment("[Image: source: /a/notes.txt]")).toBe(false);
    });
});
