import { describe, expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { SkillName } from "@ax/lib/brands";
import { skillRecordKey } from "@ax/lib/skill-id";

// Fixture skill names are plain string literals; brand via the schema constructor.
const sn = (s: string): SkillName => SkillName.make(s);
import { makeDirSource } from "./sources/dir.ts";
import { makeCommandSource } from "./sources/command.ts";
import { makeSkillSourceRegistryLayer } from "./sources/registry.ts";
import { reconcileSkills } from "./reconcile.ts";
import { scopeSkill, readAllSkills } from "./config.ts";
import type { SkillDirRef } from "./sources/types.ts";
import { publishCacheFixture, readFixture, runWithPlatform } from "@ax/lib/testing/cache-fixture";
import { duckdbTestSetup } from "@ax/lib/testing/duckdb-dylib";

const FS = Layer.mergeAll(BunFileSystem.layer, BunPath.layer);
const runFs = <A, E>(eff: Effect.Effect<A, E, any>) =>
    Effect.runPromise(eff.pipe(Effect.provide(FS)) as Effect.Effect<A, E, never>);
const runFsResult = <A, E>(eff: Effect.Effect<A, E, any>) =>
    Effect.runPromise(
        eff.pipe(
            Effect.match({
                onSuccess: (v) => ({ ok: true as const, v }),
                onFailure: (e) => ({ ok: false as const, e }),
            }),
            Effect.provide(FS),
        ) as Effect.Effect<{ ok: true; v: A } | { ok: false; e: E }, never, never>,
    );

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

const writeSkill = (root: string, name: string, fm: string, body = "BODY") => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\n${fm}\n---\n${body}\n`);
    return dir;
};

const ref = (root: string, scope: string, writable = true): SkillDirRef => ({
    root,
    scope,
    writable,
});

describe("dir source discover", () => {
    test("parses SKILL.md frontmatter into records", async () => {
        const root = tmp("ax-dir-");
        writeSkill(root, "alpha", "name: alpha\ndescription: First skill\nrole: planner");
        writeSkill(root, "beta", "name: beta\ndescription: second: has a colon");
        const src = makeDirSource({
            name: "user",
            label: "u",
            writable: true,
            roots: () => Effect.succeed([ref(root, "user")]),
        });
        const recs = await runFs(src.discover(ref(root, "user")));
        const byName = new Map(recs.map((r) => [r.name, r]));
        expect(recs).toHaveLength(2);
        expect(byName.get("alpha")?.description).toBe("First skill");
        expect(byName.get("alpha")?.roles).toEqual(["planner"]);
        expect(byName.get("alpha")?.unit).toBe("dir");
        expect(byName.get("alpha")?.bytes).toBeGreaterThan(0);
        // tolerant parse of unquoted colon in description
        expect(byName.get("beta")?.description).toBe("second: has a colon");
    });

    test("plugin source re-namespaces bare names and :->__ id stays stable", async () => {
        const root = tmp("ax-plugin-");
        writeSkill(root, "caveman", "name: caveman\ndescription: d");
        const src = makeDirSource({
            name: "plugin",
            label: "p",
            writable: false,
            roots: () => Effect.succeed([ref(root, "plugin:superpowers", false)]),
        });
        const [rec] = await runFs(src.discover(ref(root, "plugin:superpowers", false)));
        expect(rec!.name).toBe("superpowers:caveman");
        // `:`->`__` record-key rule (skill-id.ts) is stable for the namespaced name.
        expect(skillRecordKey(sn(rec!.name))).toBe(skillRecordKey(sn("superpowers:caveman")));
        expect(skillRecordKey(sn(rec!.name))).not.toContain(":");
    });

    test("skips .ax-parked and non-dir entries", async () => {
        const root = tmp("ax-skip-");
        writeSkill(root, "live", "name: live");
        mkdirSync(join(root, ".ax-parked", "hidden"), { recursive: true });
        writeFileSync(join(root, ".ax-parked", "hidden", "SKILL.md"), "---\nname: hidden\n---\nX");
        writeFileSync(join(root, "loose.txt"), "not a skill");
        const src = makeDirSource({ name: "user", label: "u", writable: true, roots: () => Effect.succeed([]) });
        const recs = await runFs(src.discover(ref(root, "user")));
        expect(recs.map((r) => r.name)).toEqual(["live"]);
    });
});

describe("read-only source guards (fail before disk touch)", () => {
    const root = tmp("ax-ro-");
    const dir = writeSkill(root, "owned", "name: owned");
    const plugin = makeDirSource({
        name: "plugin",
        label: "p",
        writable: false,
        roots: () => Effect.succeed([ref(root, "plugin:x", false)]),
    });
    const rec = {
        name: "x:owned",
        source: "plugin" as const,
        scopeTag: "plugin:x",
        dirPath: dir,
        unit: "dir" as const,
        roles: [],
        bytes: 1,
        contentHash: "h",
        writable: false,
    };

    test("plugin remove -> SkillReadOnlyError, dir untouched", async () => {
        const res = await runFsResult(plugin.remove(rec));
        expect(res.ok).toBe(false);
        expect(!res.ok && (res.e as { _tag: string })._tag).toBe("SkillReadOnlyError");
        expect(existsSync(join(dir, "SKILL.md"))).toBe(true);
    });

    test("plugin park -> SkillReadOnlyError", async () => {
        const res = await runFsResult(plugin.park(rec));
        expect(res.ok).toBe(false);
        expect(!res.ok && (res.e as { _tag: string })._tag).toBe("SkillReadOnlyError");
    });
});

describe("symlink-safe remove", () => {
    test("rm unlinks the symlink, leaves the real target intact", async () => {
        const realRepo = tmp("ax-dotfiles-");
        const realSkill = writeSkill(realRepo, "stowed", "name: stowed\ndescription: real");
        const skillsRoot = tmp("ax-stow-link-");
        const linkPath = join(skillsRoot, "stowed");
        symlinkSync(realSkill, linkPath); // ~/.claude/skills/stowed -> dotfiles/.../stowed

        const src = makeDirSource({
            name: "user",
            label: "u",
            writable: true,
            roots: () => Effect.succeed([ref(skillsRoot, "user")]),
        });
        const [rec] = await runFs(src.discover(ref(skillsRoot, "user")));
        expect(rec!.name).toBe("stowed"); // symlinked dir discovered (stat follows link)

        await runFs(src.remove(rec!));
        expect(existsSync(linkPath)).toBe(false); // link gone
        expect(existsSync(join(realSkill, "SKILL.md"))).toBe(true); // real target untouched
    });
});

describe("command source (flat .md)", () => {
    test("discovers .md, namespaces subdirs, parks + unparks", async () => {
        const root = tmp("ax-cmd-");
        writeFileSync(join(root, "simplify.md"), "---\ndescription: Simplify\n---\nrun it\n");
        mkdirSync(join(root, "gsd"), { recursive: true });
        writeFileSync(join(root, "gsd", "plan-phase.md"), "Plan the phase\n");
        const src = makeCommandSource({
            label: "c",
            writable: true,
            roots: () => Effect.succeed([ref(root, "command")]),
        });
        const recs = await runFs(src.discover(ref(root, "command")));
        const names = recs.map((r) => r.name).sort();
        expect(names).toEqual(["gsd:plan-phase", "simplify"]);
        const plan = recs.find((r) => r.name === "gsd:plan-phase")!;
        expect(plan.unit).toBe("md");
        expect(plan.description).toBe("Plan the phase"); // first-line fallback

        const simplify = recs.find((r) => r.name === "simplify")!;
        await runFs(src.park(simplify));
        expect(existsSync(join(root, "simplify.md"))).toBe(false);
        expect(existsSync(join(root, ".ax-parked", "simplify.md"))).toBe(true);
        await runFs(src.unpark("simplify", ref(root, "command")));
        expect(existsSync(join(root, "simplify.md"))).toBe(true);
    });
});

// --- real DuckDB reconciliation -------------------------------------------------

const { dylibPath, dtest, tempDir } = await duckdbTestSetup("skill config", { requireFts: true });

const skillRow = (name: string, scope = "user", deletedAt: Date | null = null) => ({
    id: skillRecordKey(SkillName.make(name)), name, scope, dir_path: `/skills/${name}`,
    content_hash: name, deleted_at: deletedAt,
});

const sourceLayer = (root: string) => makeSkillSourceRegistryLayer([
    makeDirSource({ name: "user", label: "u", writable: true, roots: () => Effect.succeed([ref(root, "user")]) }),
]);

describe("skill database behavior on real DuckDB", () => {
    dtest("reconcile discovers names and updates lifecycle rows", async () => {
        const root = tmp("ax-skill-reconcile-");
        writeSkill(root, "keep", "name: keep");
        writeSkill(root, "also", "name: also");
        for (let index = 0; index < 8; index += 1) writeSkill(root, `extra-${index}`, `name: extra-${index}`);
        let report: unknown;
        let goneDeleted = false;
        await runWithPlatform(publishCacheFixture(tempDir("ax-skill-db-"), dylibPath, (write) =>
            Effect.gen(function* () {
                yield* write.putMany("skill", [
                    skillRow("keep"), skillRow("also"), skillRow("gone"),
                    ...Array.from({ length: 8 }, (_, index) => skillRow(`extra-${index}`)),
                ]);
                report = yield* reconcileSkills(write).pipe(
                    Effect.provide(Layer.mergeAll(FS, sourceLayer(root))),
                );
                const rows = yield* write.raw("SELECT deleted_at FROM skill WHERE name = 'gone'");
                goneDeleted = rows.rows[0]?.deleted_at instanceof Date;
            }),
        ));
        expect(report).toMatchObject({ table: "skill", tombstoned: 1, tombstoneSkipped: false });
        expect(goneDeleted).toBe(true);
    });

    dtest("readAllSkills separates owned orphans from provider rows", async () => {
        const root = tmp("ax-skill-read-");
        writeSkill(root, "keep", "name: keep");
        const fixture = await runWithPlatform(publishCacheFixture(
            tempDir("ax-skill-read-db-"), dylibPath,
            (write) => write.putMany("skill", [
                skillRow("keep"), skillRow("gone"), skillRow("othertool", "codex-tool"),
            ]),
        ));
        const layer = Layer.mergeAll(readFixture(fixture.snapshotPath, dylibPath), FS, sourceLayer(root));
        const hidden = await runWithPlatform(readAllSkills().pipe(Effect.provide(layer)));
        expect(new Map(hidden.map((row) => [row.name, row.status]))).toEqual(new Map([
            ["gone", "orphan"], ["keep", "live"],
        ]));
        const all = await runWithPlatform(
            readAllSkills({ includeOutOfScope: true }).pipe(Effect.provide(layer)),
        );
        expect(new Map(all.map((row) => [row.name, row.status])).get("othertool")).toBe("out-of-scope");
    });
});

describe("scopeSkill round-trip (real fs)", () => {
    test("attach then detach via shared editAgentSkills, .bak written", async () => {
        const dir = tmp("ax-agent-");
        const agentFile = join(dir, "gtm-prospector.md");
        writeFileSync(
            agentFile,
            "---\nname: gtm-prospector\ndescription: GTM\nskills:\n  - existing\n---\nPROMPT\n",
        );
        const added = await runFs(scopeSkill("gtm-research", agentFile));
        expect(added.changed).toBe(true);
        expect(added.skills).toEqual(["existing", "gtm-research"]);
        expect(existsSync(`${agentFile}.bak`)).toBe(true);
        expect(readFileSync(agentFile, "utf8")).toContain("PROMPT");

        const removed = await runFs(scopeSkill("existing", agentFile, { remove: true }));
        expect(removed.skills).toEqual(["gtm-research"]);
    });

    test("missing agent file -> ScopeTargetError", async () => {
        const dir = tmp("ax-agent-miss-");
        const res = await runFsResult(scopeSkill("s", join(dir, "nope.md")));
        expect(res.ok).toBe(false);
        expect(!res.ok && (res.e as { _tag: string })._tag).toBe("ScopeTargetError");
    });
});
