import { describe, expect, test } from "bun:test";
import {
    checkoutRecordKey,
    commitRecordKey,
    editedRelationRecordKey,
    fileRecordKey,
    invokedRelationRecordKey,
    repositoryRecordKey,
    toolCallRecordKey,
    toolRecordKey,
    turnRecordKey,
} from "./record-keys.ts";
import { legacySkillRecordKey, skillRecordKey } from "@ax/lib/skill-id";

const HASH = "[0-9a-f]{12,16}";

describe("record keys", () => {
    test("repository key prefers normalized remote", () => {
        const key = repositoryRecordKey({
            remoteUrlNormalized: "github.com/necmttn/ax",
            initialCommit: "abc",
            checkoutRoot: "/Users/necmttn/Projects/ax",
        });

        expect(key).toMatch(new RegExp(`^remote__github_com_necmttn_ax__${HASH}$`));
    });

    test("repository key falls back to initial commit", () => {
        expect(repositoryRecordKey({ initialCommit: "a".repeat(40) })).toBe(
            "initial__aaaaaaaaaaaaaaaa",
        );
    });

    test("repository key falls back to checkout root hash", () => {
        const key = repositoryRecordKey({
            checkoutRoot: "/Users/necmttn/Projects/local-only",
        });

        expect(key.startsWith("local__Users_necmttn_Projects_local_only__")).toBe(true);
    });

    test("checkout key is tied to the local path", () => {
        const key = checkoutRecordKey("/Users/necmttn/Projects/ax");

        expect(key.startsWith("Users_necmttn_Projects_ax__")).toBe(true);
    });

    test("file key is repository scoped", () => {
        expect(fileRecordKey("remote__github_com_necmttn_ax", "src/cli/index.ts")).toMatch(
            new RegExp(
                `^remote_github_com_necmttn_ax__${HASH}__src_cli_index_ts__${HASH}$`,
            ),
        );
    });

    test("tool key separates provider and kind", () => {
        expect(toolRecordKey({ provider: "codex", kind: "cli", name: "git" })).toMatch(
            new RegExp(`^codex__${HASH}__cli__${HASH}__git__${HASH}$`),
        );
    });

    test("tool key avoids sanitized name collisions", () => {
        const dashKey = toolRecordKey({ provider: "codex", kind: "cli", name: "git-status" });
        const underscoreKey = toolRecordKey({ provider: "codex", kind: "cli", name: "git_status" });

        expect(dashKey).not.toBe(underscoreKey);
        expect(dashKey).toMatch(new RegExp(`^codex__${HASH}__cli__${HASH}__git_status__${HASH}$`));
        expect(underscoreKey).toMatch(
            new RegExp(`^codex__${HASH}__cli__${HASH}__git_status__${HASH}$`),
        );
    });

    test("tool call key uses call id when available", () => {
        expect(
            toolCallRecordKey({
                sessionId: "019df8f4-f912-7a80-8321-f8b1509fd0e5",
                seq: 7,
                callId: "call_abc",
            }),
        ).toMatch(
            new RegExp(
                `^019df8f4_f912_7a80_8321_f8b1509fd0e5__${HASH}__call_abc__${HASH}$`,
            ),
        );
    });

    test("identity parts avoid unsafe value versus hash-looking safe value collisions", () => {
        const unsafeKey = toolRecordKey({ provider: "codex", kind: "cli", name: "git-status" });
        const hashLookingKey = toolRecordKey({
            provider: "codex",
            kind: "cli",
            name: "git_status__a83972f4",
        });

        expect(unsafeKey).not.toBe(hashLookingKey);
        expect(unsafeKey).toMatch(
            new RegExp(`^codex__${HASH}__cli__${HASH}__git_status__${HASH}$`),
        );
        expect(hashLookingKey).toMatch(
            new RegExp(`^codex__${HASH}__cli__${HASH}__git_status_a83972f4__${HASH}$`),
        );
    });

    test("repository remote keys include raw identity hash", () => {
        const dashKey = repositoryRecordKey({ remoteUrlNormalized: "github.com/acme/a-b" });
        const underscoreKey = repositoryRecordKey({ remoteUrlNormalized: "github.com/acme/a_b" });

        expect(dashKey).not.toBe(underscoreKey);
        expect(dashKey).toMatch(new RegExp(`^remote__github_com_acme_a_b__${HASH}$`));
        expect(underscoreKey).toMatch(new RegExp(`^remote__github_com_acme_a_b__${HASH}$`));
    });

    test("file path keys include raw identity hash", () => {
        const dashKey = fileRecordKey("remote__repo", "src/a-b.ts");
        const underscoreKey = fileRecordKey("remote__repo", "src/a_b.ts");

        expect(dashKey).not.toBe(underscoreKey);
        expect(dashKey).toMatch(new RegExp(`^remote_repo__${HASH}__src_a_b_ts__${HASH}$`));
        expect(underscoreKey).toMatch(new RegExp(`^remote_repo__${HASH}__src_a_b_ts__${HASH}$`));
    });

    test("file key normalizes repository record id strings to raw repository keys", () => {
        const rawKey = fileRecordKey("remote__github_com_necmttn_ax", "src/cli/index.ts");
        const recordIdKey = fileRecordKey(
            "repository:remote__github_com_necmttn_ax",
            "src/cli/index.ts",
        );

        expect(recordIdKey).toBe(rawKey);
    });

    test("tool call key avoids sanitized call id collisions", () => {
        const dashKey = toolCallRecordKey({
            sessionId: "019df8f4-f912-7a80-8321-f8b1509fd0e5",
            seq: 7,
            callId: "call-abc",
        });
        const underscoreKey = toolCallRecordKey({
            sessionId: "019df8f4-f912-7a80-8321-f8b1509fd0e5",
            seq: 7,
            callId: "call_abc",
        });

        expect(dashKey).not.toBe(underscoreKey);
        expect(dashKey).toMatch(
            new RegExp(
                `^019df8f4_f912_7a80_8321_f8b1509fd0e5__${HASH}__call_abc__${HASH}$`,
            ),
        );
        expect(underscoreKey).toMatch(
            new RegExp(
                `^019df8f4_f912_7a80_8321_f8b1509fd0e5__${HASH}__call_abc__${HASH}$`,
            ),
        );
    });

    test("tool call key avoids sanitized session collisions with call ids", () => {
        const dashedSessionKey = toolCallRecordKey({
            sessionId: "a-b",
            seq: 1,
            callId: "call_x",
        });
        const compactSessionKey = toolCallRecordKey({
            sessionId: "ab",
            seq: 1,
            callId: "call_x",
        });

        expect(dashedSessionKey).not.toBe(compactSessionKey);
        expect(dashedSessionKey).toMatch(new RegExp(`^a_b__${HASH}__call_x__${HASH}$`));
        expect(compactSessionKey).toMatch(new RegExp(`^ab__${HASH}__call_x__${HASH}$`));
    });

    test("tool call key avoids sanitized session collisions with seq fallback", () => {
        const dashedSessionKey = toolCallRecordKey({ sessionId: "a-b", seq: 1 });
        const compactSessionKey = toolCallRecordKey({ sessionId: "ab", seq: 1 });

        expect(dashedSessionKey).not.toBe(compactSessionKey);
        expect(dashedSessionKey).toMatch(new RegExp(`^a_b__${HASH}__seq_000001$`));
        expect(compactSessionKey).toMatch(new RegExp(`^ab__${HASH}__seq_000001$`));
    });

    test("fileRecordKey normalizes SDK-style repository record IDs", () => {
        expect(fileRecordKey("repository:`remote__github_com_org_repo__abc123`", "src/index.ts"))
            .toBe(fileRecordKey("remote__github_com_org_repo__abc123", "src/index.ts"));
    });

    test("commitRecordKey normalizes plain and record-literal repository keys", () => {
        expect(commitRecordKey("repository:`remote__repo__001`", "a".repeat(40)))
            .toBe(commitRecordKey("remote__repo__001", "a".repeat(40)));
    });

    test("turnRecordKey is centralized and deterministic", () => {
        expect(turnRecordKey("session-abc", 7)).toMatch(/^session_abc__[a-f0-9]{16}__seq_000007$/);
    });

    test("invoked relation key keeps same turn skill with different args distinct", () => {
        const base = {
            turnKey: "turn_a",
            skillKey: "skill_a",
        };

        expect(invokedRelationRecordKey({ ...base, args: "{\"x\":1}" })).toBe(
            invokedRelationRecordKey({ ...base, args: "{\"x\":1}" }),
        );
        expect(invokedRelationRecordKey({ ...base, args: "{\"x\":1}" })).not.toBe(
            invokedRelationRecordKey({ ...base, args: "{\"x\":2}" }),
        );
    });

    test("edited relation key is stable per turn file tool", () => {
        expect(editedRelationRecordKey({
            turnKey: "turn_a",
            fileKey: "file_a",
            tool: "Edit",
        })).toBe(editedRelationRecordKey({
            turnKey: "turn_a",
            fileKey: "file_a",
            tool: "Edit",
        }));
        expect(editedRelationRecordKey({
            turnKey: "turn_a",
            fileKey: "file_a",
            tool: "Edit",
        })).not.toBe(editedRelationRecordKey({
            turnKey: "turn_a",
            fileKey: "file_a",
            tool: "Write",
        }));
    });

    test("toolCallRecordKey keeps call id distinct from seq fallback", () => {
        expect(toolCallRecordKey({ sessionId: "s1", seq: 1, callId: "seq_000001" }))
            .not.toBe(toolCallRecordKey({ sessionId: "s1", seq: 1 }));
    });

    test("repository and checkout IDs stay deterministic", () => {
        expect(repositoryRecordKey({ remoteUrlNormalized: "github.com/org/repo" }))
            .toBe(repositoryRecordKey({ remoteUrlNormalized: "github.com/org/repo" }));
        expect(checkoutRecordKey("/tmp/repo")).toBe(checkoutRecordKey("/tmp/repo"));
    });
});

test("skillRecordKey does not collide on colon and double underscore names", () => {
    expect(skillRecordKey("a:b")).not.toBe(skillRecordKey("a__b"));
});

test("legacySkillRecordKey preserves old lookup behavior", () => {
    expect(legacySkillRecordKey("plugin:name")).toBe("plugin__name");
});
