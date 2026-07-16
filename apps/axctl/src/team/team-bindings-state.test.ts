import { afterEach, describe, expect, test } from "bun:test";
import { chooseIdentity } from "../ingest/repository-identity.ts";
import {
    bindingFor,
    loadTeamBindings,
    removeTeamBinding,
    upsertTeamBinding,
} from "./team-bindings-state.ts";

const dir = `/tmp/ax-team-bindings-state-test-${process.pid}`;
const path = `${dir}/team-bindings.json`;

afterEach(async () => {
    await Bun.$`rm -rf ${dir}`.quiet().nothrow();
});

describe("team bindings state", () => {
    test("missing file is default-deny", async () => {
        const state = await loadTeamBindings(path);

        expect(state).toEqual({ v: 1, bindings: {} });
        expect(bindingFor(state, "repository-key")).toBeUndefined();
    });

    test("join upserts, re-join updates, and leave removes", async () => {
        await upsertTeamBinding(path, "repo-client", {
            org: "acme",
            share: "anon",
            joined_at: "2026-07-16T01:00:00.000Z",
        });
        expect(bindingFor(await loadTeamBindings(path), "repo-client")).toEqual({
            org: "acme",
            share: "anon",
            joined_at: "2026-07-16T01:00:00.000Z",
        });

        await upsertTeamBinding(path, "repo-client", {
            org: "acme-labs",
            share: "full",
            joined_at: "2026-07-16T02:00:00.000Z",
        });
        expect(bindingFor(await loadTeamBindings(path), "repo-client")).toEqual({
            org: "acme-labs",
            share: "full",
            joined_at: "2026-07-16T02:00:00.000Z",
        });

        expect(await removeTeamBinding(path, "repo-client")).toBe(true);
        expect(bindingFor(await loadTeamBindings(path), "repo-client")).toBeUndefined();
    });

    test("fork and rename identities remain separate bindings", async () => {
        const client = chooseIdentity({
            remoteUrlNormalized: "github.com/acme/client",
            initialCommit: "same-root",
            checkoutRoot: "/work/client",
        });
        const personalFork = chooseIdentity({
            remoteUrlNormalized: "github.com/alice/client-fork",
            initialCommit: "same-root",
            checkoutRoot: "/work/client-fork",
        });

        expect(client.repositoryKey).not.toBe(personalFork.repositoryKey);

        await upsertTeamBinding(path, client.repositoryKey, {
            org: "acme",
            share: "anon",
            joined_at: "2026-07-16T01:00:00.000Z",
        });
        await upsertTeamBinding(path, personalFork.repositoryKey, {
            org: "alice",
            share: "full",
            joined_at: "2026-07-16T02:00:00.000Z",
        });

        const state = await loadTeamBindings(path);
        expect(bindingFor(state, client.repositoryKey)?.org).toBe("acme");
        expect(bindingFor(state, personalFork.repositoryKey)?.org).toBe("alice");
    });

    test("multiple repos can bind to different orgs", async () => {
        await upsertTeamBinding(path, "repo-one", {
            org: "org-one",
            share: "anon",
            joined_at: "2026-07-16T01:00:00.000Z",
        });
        await upsertTeamBinding(path, "repo-two", {
            org: "org-two",
            share: "anon",
            joined_at: "2026-07-16T02:00:00.000Z",
        });

        const state = await loadTeamBindings(path);
        expect(bindingFor(state, "repo-one")?.org).toBe("org-one");
        expect(bindingFor(state, "repo-two")?.org).toBe("org-two");
    });
});
