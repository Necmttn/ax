import { describe, expect, it } from "bun:test";
import {
    gistApiArgs,
    gistBundlePayload,
    parseGistApiOutput,
    shareUrlForGist,
} from "./gist.ts";
import { minimalShareArtifact } from "./artifact.ts";
import { buildShareBundle } from "./manifest.ts";

describe("gist helpers", () => {
    it("parses owner and gist id from gh api JSON", () => {
        const parsed = parseGistApiOutput(
            JSON.stringify({ id: "abc123def456", owner: { login: "necmttn" }, html_url: "x" }),
        );
        expect(parsed).toEqual({ owner: "necmttn", gistId: "abc123def456" });
    });

    it("tolerates anonymous gists (no owner)", () => {
        expect(parseGistApiOutput(JSON.stringify({ id: "abc123" }))).toEqual({
            owner: "",
            gistId: "abc123",
        });
    });

    it("returns null for unparseable / id-less output", () => {
        expect(parseGistApiOutput("not json")).toBeNull();
        expect(parseGistApiOutput(JSON.stringify({ owner: { login: "x" } }))).toBeNull();
    });

    it("builds canonical ax share URLs", () => {
        expect(shareUrlForGist({ owner: "necmttn", gistId: "abc123" })).toBe(
            "https://ax.necmttn.com/s/necmttn/abc123",
        );
    });

    it("POSTs the gist body from stdin via gh api", () => {
        expect(gistApiArgs()).toEqual(["gh", "api", "--method", "POST", "/gists", "--input", "-"]);
    });

    it("serializes the bundle into a files map with stringified content", () => {
        const bundle = buildShareBundle(minimalShareArtifact({ id: "abc123", source: "codex" }));
        const payload = gistBundlePayload({ bundle, public: true });

        expect(payload.public).toBe(true);
        expect(payload.description).toContain("abc123");
        expect(Object.keys(payload.files).sort()).toEqual(["index.json", "session.json"]);
        // Each file's content is a JSON string, not a nested object.
        expect(typeof payload.files["index.json"]!.content).toBe("string");
        expect(JSON.parse(payload.files["index.json"]!.content).kind).toBe("manifest");
    });
});
