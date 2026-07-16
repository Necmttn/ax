import { afterEach, describe, expect, test } from "bun:test";
import { chooseIdentity } from "../ingest/repository-identity.ts";
import { loadTeamBindings } from "./team-bindings-state.ts";
import {
    joinTeamBinding,
    leaveTeamBinding,
    statusTeamBindings,
    type TeamRepositoryContext,
} from "./team-bindings-commands.ts";

const dir = `/tmp/ax-team-bindings-commands-test-${process.pid}`;
const path = `${dir}/team-bindings.json`;

afterEach(async () => {
    await Bun.$`rm -rf ${dir}`.quiet().nothrow();
});

const repo = (remote: string, root: string): TeamRepositoryContext => {
    const identity = chooseIdentity({
        remoteUrlNormalized: remote,
        initialCommit: "initial",
        checkoutRoot: root,
    });
    return {
        repoKey: identity.repositoryKey,
        name: remote.split("/").at(-1) ?? remote,
        repoRoot: root,
        remoteUrlNormalized: remote,
    };
};

describe("team binding command handlers", () => {
    test("status reports default-deny when nothing is bound", async () => {
        const lines: string[] = [];

        await statusTeamBindings({
            statePath: path,
            currentRepo: null,
            write: (line) => lines.push(line),
        });

        expect(lines.join("\n")).toMatch(/no repos bound|default-deny/i);
        expect(await loadTeamBindings(path)).toEqual({ v: 1, bindings: {} });
    });

    test("join shows exact consent details and writes the real state file", async () => {
        const current = repo("github.com/acme/client", "/work/client");
        const lines: string[] = [];

        const outcome = await joinTeamBinding({
            org: "acme",
            currentRepo: current,
            statePath: path,
            confirmed: true,
            now: "2026-07-16T03:00:00.000Z",
            write: (line) => lines.push(line),
        });

        expect(outcome).toBe("joined");
        const output = lines.join("\n");
        expect(output).toContain(current.repoKey);
        expect(output).toContain("github.com/acme/client");
        expect(output).toContain("acme");
        expect(output).toContain("share: anon");
        expect(output).toMatch(/aggregate|skills|models/i);
        expect(output).toMatch(/no transcripts|no code/i);
        expect((await loadTeamBindings(path)).bindings[current.repoKey]).toEqual({
            org: "acme",
            share: "anon",
            joined_at: "2026-07-16T03:00:00.000Z",
        });
    });

    test("join aborts without consent and leaves no binding", async () => {
        const current = repo("github.com/acme/client", "/work/client");

        expect(
            await joinTeamBinding({
                org: "acme",
                currentRepo: current,
                statePath: path,
                confirmed: false,
                now: "2026-07-16T03:00:00.000Z",
                write: () => undefined,
            }),
        ).toBe("aborted");
        expect((await loadTeamBindings(path)).bindings).toEqual({});
    });

    test("status lists independent orgs and marks the current repo", async () => {
        const one = repo("github.com/acme/one", "/work/one");
        const two = repo("github.com/other/two", "/work/two");
        await joinTeamBinding({
            org: "acme",
            currentRepo: one,
            statePath: path,
            confirmed: true,
            now: "2026-07-16T01:00:00.000Z",
            write: () => undefined,
        });
        await joinTeamBinding({
            org: "other",
            currentRepo: two,
            statePath: path,
            confirmed: true,
            now: "2026-07-16T02:00:00.000Z",
            write: () => undefined,
        });
        const lines: string[] = [];

        await statusTeamBindings({
            statePath: path,
            currentRepo: two,
            write: (line) => lines.push(line),
        });

        const output = lines.join("\n");
        expect(output).toContain(`${one.repoKey} → acme`);
        expect(output).toContain(`${two.repoKey} → other`);
        expect(output).toMatch(new RegExp(`\\* .*${two.repoKey}`));
    });

    test("leave removes only the current repo and is a no-op when already unbound", async () => {
        const one = repo("github.com/acme/one", "/work/one");
        const two = repo("github.com/other/two", "/work/two");
        await joinTeamBinding({
            org: "acme",
            currentRepo: one,
            statePath: path,
            confirmed: true,
            now: "2026-07-16T01:00:00.000Z",
            write: () => undefined,
        });
        await joinTeamBinding({
            org: "other",
            currentRepo: two,
            statePath: path,
            confirmed: true,
            now: "2026-07-16T02:00:00.000Z",
            write: () => undefined,
        });

        expect(
            await leaveTeamBinding({
                currentRepo: one,
                statePath: path,
                write: () => undefined,
            }),
        ).toBe("left");
        const state = await loadTeamBindings(path);
        expect(state.bindings[one.repoKey]).toBeUndefined();
        expect(state.bindings[two.repoKey]?.org).toBe("other");

        const lines: string[] = [];
        expect(
            await leaveTeamBinding({
                currentRepo: one,
                statePath: path,
                write: (line) => lines.push(line),
            }),
        ).toBe("unbound");
        expect(lines.join("\n")).toMatch(/not bound|nothing to do/i);
    });
});
