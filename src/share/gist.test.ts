import { describe, expect, it } from "bun:test";
import {
    gistCreateArgs,
    parseGistCreateOutput,
    shareUrlForGist,
} from "./gist.ts";

describe("gist helpers", () => {
    it("parses owner and gist id from gh output", () => {
        const parsed = parseGistCreateOutput("https://gist.github.com/necmttn/abc123def456\n");
        expect(parsed).toEqual({ owner: "necmttn", gistId: "abc123def456" });
    });

    it("returns null for unparseable gh output", () => {
        expect(parseGistCreateOutput("created gist but no url")).toBeNull();
    });

    it("builds canonical ax share URLs", () => {
        expect(shareUrlForGist({ owner: "necmttn", gistId: "abc123" })).toBe(
            "https://ax.necmttn.com/s/necmttn/abc123",
        );
    });

    it("omits visibility flags for default private gists", () => {
        const args = gistCreateArgs({ public: false });

        expect(args).toEqual([
            "gh",
            "gist",
            "create",
            "--filename",
            "ax-session.json",
            "-",
        ]);
        expect(args).not.toContain("--public");
        expect(args).not.toContain("--secret");
    });

    it("passes public visibility flag for public gists", () => {
        expect(gistCreateArgs({ public: true })).toEqual([
            "gh",
            "gist",
            "create",
            "--public",
            "--filename",
            "ax-session.json",
            "-",
        ]);
    });
});
