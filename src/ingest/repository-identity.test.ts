import { describe, expect, test } from "bun:test";
import {
    chooseIdentity,
    classifyCheckoutKind,
    normalizeGitRemoteUrl,
} from "./repository-identity.ts";

describe("repository identity", () => {
    test("normalizes ssh GitHub remotes", () => {
        expect(normalizeGitRemoteUrl("git@github.com:Necmttn/agentctl.git")).toBe(
            "github.com/necmttn/agentctl",
        );
    });

    test("normalizes https GitHub remotes", () => {
        expect(normalizeGitRemoteUrl("https://github.com/Necmttn/agentctl.git")).toBe(
            "github.com/necmttn/agentctl",
        );
    });

    test("returns null for blank remotes", () => {
        expect(normalizeGitRemoteUrl("")).toBeNull();
    });

    test("classifies linked worktrees from gitdir files", () => {
        expect(classifyCheckoutKind("gitdir: /repo/.git/worktrees/a")).toBe("worktree");
    });

    test("classifies directory git dirs as normal checkouts", () => {
        expect(classifyCheckoutKind("directory")).toBe("normal");
    });

    test("chooses remote identity before initial commit and local path", () => {
        expect(
            chooseIdentity({
                remoteUrlNormalized: "github.com/necmttn/agentctl",
                initialCommit: "a".repeat(40),
                checkoutRoot: "/tmp/agentctl",
            }),
        ).toEqual({
            kind: "remote",
            repositoryKey: expect.stringMatching(/^remote__github_com_necmttn_agentctl__/),
        });
    });

    test("chooses initial commit identity before local path", () => {
        expect(
            chooseIdentity({
                initialCommit: "a".repeat(40),
                checkoutRoot: "/tmp/agentctl",
            }),
        ).toEqual({
            kind: "initial_commit",
            repositoryKey: "initial__aaaaaaaaaaaaaaaa",
        });
    });

    test("falls back to local path hash identity", () => {
        expect(chooseIdentity({ checkoutRoot: "/tmp/agentctl" })).toEqual({
            kind: "local_path_hash",
            repositoryKey: expect.stringMatching(/^local__tmp_agentctl__/),
        });
    });
});
