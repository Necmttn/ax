import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { AX_ATTRIBUTION_MD, AX_URL } from "@ax/lib/shared/attribution";
import { OG_RENDER_REV } from "@ax/lib/shared/og-meta";
import { GitHubEnvTest } from "./github-env.ts";
import type { ProfileV1 } from "./schema.ts";
import {
    PROFILE_WIDGET_END,
    PROFILE_WIDGET_START,
    buildProfileWidgetImageUrl,
    installOrUpdateProfileWidget,
    renderProfileWidget,
    replaceProfileWidget,
    shouldSkipWidgetRefresh,
    widgetStateMatchesOwner,
} from "./widget.ts";

const profile = {
    v: 1,
    github: "Necmttn",
    generated_at: "2026-06-12T19:00:00Z",
    window_days: 30,
    stats: {
        sessions: 42,
        active_days: 18,
        streak_days: 6,
        tokens: { prompt: 2_600_000, completion: 500_000, total: 3_100_000 },
        models: [],
        harnesses: ["claude-code", "codex"],
    },
    rig: { skills: [], hooks: [], routing_table: false },
} satisfies ProfileV1;

const run = <A, E>(eff: Effect.Effect<A, E, never>) => Effect.runPromise(eff);
const encode = (s: string): string => Buffer.from(s, "utf8").toString("base64");
const decode = (s: string): string => Buffer.from(s, "base64").toString("utf8");

describe("renderProfileWidget", () => {
    test("renders the marker-delimited README block with card, mono stats, and ax link", () => {
        const block = renderProfileWidget(profile);

        expect(block).toStartWith(PROFILE_WIDGET_START);
        expect(block).toEndWith(PROFILE_WIDGET_END);
        expect(block).toContain(`https://ax.necmttn.com/og-profile/Necmttn?r=${OG_RENDER_REV}`);
        expect(block).toContain("<code>42 sessions | 3.1M tokens | 18 active days | 6-day streak</code>");
        expect(block).toContain(`[measured by ax](${AX_URL})`);
        expect(block).toContain(AX_ATTRIBUTION_MD);
    });

    test("keeps the profile card URL cache-busted by the current OG render revision", () => {
        expect(buildProfileWidgetImageUrl("octocat")).toBe(
            `https://ax.necmttn.com/og-profile/octocat?r=${OG_RENDER_REV}`,
        );
    });
});

describe("replaceProfileWidget", () => {
    test("replaces only the content between existing markers", () => {
        const nextBlock = renderProfileWidget(profile);
        const existing = [
            "# Necmttn",
            "",
            "Intro stays.",
            "",
            PROFILE_WIDGET_START,
            "old generated block",
            PROFILE_WIDGET_END,
            "",
            "Footer stays.",
        ].join("\n");

        const updated = replaceProfileWidget(existing, nextBlock);

        expect(updated).toContain("Intro stays.");
        expect(updated).toContain("Footer stays.");
        expect(updated).toContain(nextBlock);
        expect(updated).not.toContain("old generated block");
        expect(updated.indexOf("Intro stays.")).toBeLessThan(updated.indexOf(PROFILE_WIDGET_START));
        expect(updated.indexOf(PROFILE_WIDGET_END)).toBeLessThan(updated.indexOf("Footer stays."));
    });

    test("appends the block when the README has no ax markers", () => {
        const nextBlock = renderProfileWidget(profile);
        const updated = replaceProfileWidget("# Necmttn\n\nIntro stays.\n", nextBlock);

        expect(updated).toBe(`# Necmttn\n\nIntro stays.\n\n${nextBlock}\n`);
    });
});

describe("installOrUpdateProfileWidget", () => {
    test("creates README.md when the profile README path does not exist", async () => {
        const t = GitHubEnvTest({
            responses: {
                "PUT /repos/Necmttn/Necmttn/contents/README.md": {
                    content: { html_url: "https://github.com/Necmttn/Necmttn/blob/main/README.md" },
                },
            },
        });

        const result = await run(
            installOrUpdateProfileWidget({ profile }).pipe(Effect.provide(t.layer)),
        );

        expect(result).toEqual({
            status: "created",
            url: "https://github.com/Necmttn/Necmttn/blob/main/README.md",
        });
        const put = t.calls.find((c) => c.method === "PUT");
        expect(put?.path).toBe("/repos/Necmttn/Necmttn/contents/README.md");
        const body = put?.body as { content: string; sha?: string; message: string };
        expect(body.sha).toBeUndefined();
        expect(body.message).toBe("docs: update ax profile widget");
        expect(decode(body.content)).toBe(`${renderProfileWidget(profile)}\n`);
    });

    test("updates README.md by replacing only the generated block", async () => {
        const existing = [
            "# Necmttn",
            "",
            "Intro stays.",
            "",
            PROFILE_WIDGET_START,
            "old generated block",
            PROFILE_WIDGET_END,
            "",
            "Footer stays.",
        ].join("\n");
        const t = GitHubEnvTest({
            responses: {
                "GET /repos/Necmttn/Necmttn/contents/README.md": {
                    content: encode(existing),
                    encoding: "base64",
                    sha: "readme-sha",
                },
                "PUT /repos/Necmttn/Necmttn/contents/README.md": {
                    content: { html_url: "https://github.com/Necmttn/Necmttn/blob/main/README.md" },
                },
            },
        });

        const result = await run(
            installOrUpdateProfileWidget({ profile }).pipe(Effect.provide(t.layer)),
        );

        expect(result.status).toBe("updated");
        const put = t.calls.find((c) => c.method === "PUT");
        const body = put?.body as { content: string; sha?: string };
        const updated = decode(body.content);
        expect(body.sha).toBe("readme-sha");
        expect(updated).toContain("# Necmttn");
        expect(updated).toContain("Intro stays.");
        expect(updated).toContain("Footer stays.");
        expect(updated).toContain(renderProfileWidget(profile));
        expect(updated).not.toContain("old generated block");
    });

    test("does not commit when the README already contains the current block", async () => {
        const current = `# Necmttn\n\n${renderProfileWidget(profile)}\n`;
        const t = GitHubEnvTest({
            responses: {
                "GET /repos/Necmttn/Necmttn/contents/README.md": {
                    content: encode(current),
                    encoding: "base64",
                    sha: "readme-sha",
                    html_url: "https://github.com/Necmttn/Necmttn/blob/main/README.md",
                },
            },
        });

        const result = await run(
            installOrUpdateProfileWidget({ profile }).pipe(Effect.provide(t.layer)),
        );

        expect(result).toEqual({
            status: "unchanged",
            url: "https://github.com/Necmttn/Necmttn/blob/main/README.md",
        });
        expect(t.calls.map((c) => c.method)).toEqual(["GET"]);
    });

    test("does not overwrite an existing README when GitHub does not return base64 content", async () => {
        const t = GitHubEnvTest({
            responses: {
                "GET /repos/Necmttn/Necmttn/contents/README.md": {
                    encoding: "none",
                    sha: "readme-sha",
                    html_url: "https://github.com/Necmttn/Necmttn/blob/main/README.md",
                },
            },
        });

        const result = await run(
            installOrUpdateProfileWidget({ profile }).pipe(Effect.provide(t.layer)),
        );

        expect(result).toEqual({
            status: "unchanged",
            url: "https://github.com/Necmttn/Necmttn/blob/main/README.md",
        });
        expect(t.calls.map((c) => c.method)).toEqual(["GET"]);
    });
});

describe("shouldSkipWidgetRefresh", () => {
    test("watcher path is silent until first consent creates widget state", () => {
        expect(shouldSkipWidgetRefresh(null, 2, "2026-06-12T19:00:00Z")).toBe(true);
    });

    test("watcher path skips fresh state and refreshes stale state", () => {
        const state = {
            v: 1,
            owner: "Necmttn",
            consented_at: "2026-06-12T10:00:00Z",
            updated_at: "2026-06-12T10:00:00Z",
            window_days: 30,
        } as const;

        expect(shouldSkipWidgetRefresh(state, 2, "2026-06-12T11:00:00Z")).toBe(true);
        expect(shouldSkipWidgetRefresh(state, 2, "2026-06-12T13:01:00Z")).toBe(false);
    });
});

describe("widgetStateMatchesOwner", () => {
    const state = {
        v: 1,
        owner: "Necmttn",
        consented_at: "2026-06-12T10:00:00Z",
        updated_at: "2026-06-12T10:00:00Z",
        window_days: 30,
    } as const;

    test("matches GitHub owners case-insensitively", () => {
        expect(widgetStateMatchesOwner(state, "necmttn")).toBe(true);
    });

    test("does not treat another GitHub account as consented", () => {
        expect(widgetStateMatchesOwner(state, "octocat")).toBe(false);
        expect(widgetStateMatchesOwner(null, "Necmttn")).toBe(false);
    });
});
