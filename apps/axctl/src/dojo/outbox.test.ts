// apps/axctl/src/dojo/outbox.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { listDrafts, parseDraftFrontmatter, writeDraft } from "./outbox.ts";

describe("parseDraftFrontmatter", () => {
    test("extracts title/kind/created_at/session; file is basename, path is full", () => {
        const md = "---\ntitle: Fix scanner\nkind: bug\ncreated_at: 2026-06-13T10:00:00.000Z\nsession: s1\n---\nbody\n";
        expect(parseDraftFrontmatter("/out/x.md", md)).toEqual({
            file: "x.md", path: "/out/x.md", title: "Fix scanner", kind: "bug",
            created_at: "2026-06-13T10:00:00.000Z", session: "s1",
        });
    });
    test("missing optional session -> null; non-frontmatter -> null", () => {
        expect(parseDraftFrontmatter("y.md", "---\ntitle: T\nkind: improvement\ncreated_at: 2026-01-01T00:00:00Z\n---\n")?.session).toBeNull();
        expect(parseDraftFrontmatter("z.md", "no frontmatter")).toBeNull();
    });
});

describe("writeDraft + listDrafts", () => {
    test("writes a frontmatter draft and lists it back", async () => {
        const base = mkdtempSync(`${tmpdir()}/dojo-outbox-`);
        const run = <A>(e: Effect.Effect<A, unknown, any>) =>
            Effect.runPromise(e.pipe(Effect.provide(BunFileSystem.layer)) as Effect.Effect<A, unknown, never>);
        const written = await run(writeDraft({
            title: "Fix the scanner!", kind: "bug", body: "repro steps",
            session: "s1", nowMs: Date.parse("2026-06-13T10:00:00.000Z"), outboxDir: base,
        }));
        expect(written.path).toMatch(/fix-the-scanner-[0-9a-f]{8}\.md$/);
        const drafts = await run(listDrafts(base));
        expect(drafts).toHaveLength(1);
        expect(drafts[0]).toMatchObject({ title: "Fix the scanner!", kind: "bug", session: "s1" });
        expect(drafts[0]?.path).toBe(written.path);
    });
    test("newline in title can't inject extra frontmatter keys", async () => {
        const base = mkdtempSync(`${tmpdir()}/dojo-outbox-`);
        const run = <A>(e: Effect.Effect<A, unknown, any>) =>
            Effect.runPromise(e.pipe(Effect.provide(BunFileSystem.layer)) as Effect.Effect<A, unknown, never>);
        await run(writeDraft({
            title: "foo\nkind: injected", kind: "bug", body: "body",
            nowMs: Date.parse("2026-06-13T10:00:00.000Z"), outboxDir: base,
        }));
        const drafts = await run(listDrafts(base));
        expect(drafts).toHaveLength(1);
        // The injected "kind: injected" line must not win - real kind survives, title is one line.
        expect(drafts[0]?.kind).toBe("bug");
        expect(drafts[0]?.title).toBe("foo kind: injected");
    });
    test("missing outbox dir -> []", async () => {
        const drafts = await Effect.runPromise(
            listDrafts("/no/such/dir").pipe(Effect.provide(BunFileSystem.layer)) as Effect.Effect<any, unknown, never>,
        );
        expect(drafts).toEqual([]);
    });
});
