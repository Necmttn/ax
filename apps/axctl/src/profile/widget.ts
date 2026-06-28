/**
 * GitHub profile README widget: a marker-delimited block in
 * username/username/README.md, updated through GitHub's contents API.
 */
import { Effect } from "effect";
import { buildProfileOgImageUrl } from "@ax/lib/shared/og-meta";
import { atomicWriteJson } from "./fs.ts";
import { GitHubApiError, GitHubEnv } from "./github-env.ts";
import { isStale } from "./publish.ts";
import type { ProfileV1 } from "./schema.ts";

export const PROFILE_WIDGET_START = "<!--START_SECTION:ax-->";
export const PROFILE_WIDGET_END = "<!--END_SECTION:ax-->";

export interface ProfileWidgetState {
    readonly v: 1;
    readonly owner: string;
    readonly consented_at: string;
    readonly updated_at: string;
    readonly window_days: number;
}

export type ProfileWidgetResult =
    | { readonly status: "created"; readonly url: string }
    | { readonly status: "updated"; readonly url: string }
    | { readonly status: "unchanged"; readonly url: string };

export const defaultWidgetStatePath = (): string =>
    `${process.env.HOME}/.ax/profile-widget.json`;

export async function loadWidgetState(path: string): Promise<ProfileWidgetState | null> {
    try {
        const file = Bun.file(path);
        if (!(await file.exists())) return null;
        const raw: unknown = JSON.parse(await file.text());
        if (typeof raw !== "object" || raw === null) return null;
        const r = raw as Record<string, unknown>;
        if (
            r.v !== 1 ||
            typeof r.owner !== "string" ||
            typeof r.consented_at !== "string" ||
            typeof r.updated_at !== "string" ||
            typeof r.window_days !== "number"
        ) {
            return null;
        }
        return {
            v: 1,
            owner: r.owner,
            consented_at: r.consented_at,
            updated_at: r.updated_at,
            window_days: r.window_days,
        };
    } catch {
        return null;
    }
}

export async function saveWidgetState(path: string, state: ProfileWidgetState): Promise<void> {
    await atomicWriteJson(path, state);
}

export function shouldSkipWidgetRefresh(
    state: ProfileWidgetState | null,
    ifStaleHours: number,
    nowIso: string,
): boolean {
    return state === null || !isStale(state.updated_at, ifStaleHours, nowIso);
}

export function buildProfileWidgetImageUrl(login: string): string {
    return buildProfileOgImageUrl(login);
}

const compact = (n: number): string => {
    if (!Number.isFinite(n)) return "0";
    const abs = Math.abs(n);
    const fmt = (value: number, suffix: string) =>
        `${value.toFixed(value >= 10 ? 0 : 1).replace(/\.0$/, "")}${suffix}`;
    if (abs >= 1_000_000_000) return fmt(n / 1_000_000_000, "B");
    if (abs >= 1_000_000) return fmt(n / 1_000_000, "M");
    if (abs >= 1_000) return fmt(n / 1_000, "K");
    return Math.round(n).toLocaleString("en-US");
};

const plural = (n: number, one: string, many = `${one}s`): string =>
    `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export function renderProfileWidget(profile: ProfileV1): string {
    const login = profile.github;
    const profileUrl = `https://ax.necmttn.com/u/${login}`;
    const imageUrl = buildProfileWidgetImageUrl(login);
    const statLine = [
        plural(profile.stats.sessions, "session"),
        `${compact(profile.stats.tokens.total)} tokens`,
        plural(profile.stats.active_days, "active day"),
        `${profile.stats.streak_days.toLocaleString("en-US")}-day streak`,
    ].join(" | ");

    return [
        PROFILE_WIDGET_START,
        `[![ax profile for @${login}](${imageUrl})](${profileUrl})`,
        "",
        `<sub><code>${statLine}</code></sub>`,
        `<sub>[measured by ax](https://github.com/Necmttn/ax)</sub>`,
        PROFILE_WIDGET_END,
    ].join("\n");
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function replaceProfileWidget(readme: string, block: string): string {
    const existingBlock = new RegExp(
        `${escapeRegExp(PROFILE_WIDGET_START)}[\\s\\S]*?${escapeRegExp(PROFILE_WIDGET_END)}`,
    );
    if (existingBlock.test(readme)) {
        return readme.replace(existingBlock, block);
    }
    if (readme.length === 0) return `${block}\n`;
    const prefix = readme.endsWith("\n") ? readme : `${readme}\n`;
    return `${prefix}\n${block}\n`;
}

const asRecord = (u: unknown): Record<string, unknown> =>
    typeof u === "object" && u !== null ? (u as Record<string, unknown>) : {};

const decodeReadme = (
    raw: unknown,
    login: string,
): { readonly text: string; readonly sha: string | null; readonly url: string } => {
    const r = asRecord(raw);
    const content = typeof r.content === "string" ? r.content.replace(/\s/g, "") : "";
    const encoding = typeof r.encoding === "string" ? r.encoding : "";
    const sha = typeof r.sha === "string" ? r.sha : null;
    const url = typeof r.html_url === "string" ? r.html_url : `https://github.com/${login}/${login}`;
    if (encoding !== "base64" || content === "") return { text: "", sha, url };
    return { text: Buffer.from(content, "base64").toString("utf8"), sha, url };
};

const contentUrl = (login: string): string => `/repos/${login}/${login}/contents/README.md`;

export const installOrUpdateProfileWidget = Effect.fn("profile.installOrUpdateProfileWidget")(
    function* (input: { readonly profile: ProfileV1 }) {
        const gh = yield* GitHubEnv;
        const login = input.profile.github;
        const path = contentUrl(login);
        const current = yield* gh.api("GET", path).pipe(
            Effect.map((raw) => ({ found: true as const, ...decodeReadme(raw, login) })),
            Effect.catchTag("GitHubApiError", (e: GitHubApiError) =>
                e.status === 404
                    ? Effect.succeed({
                        found: false as const,
                        text: "",
                        sha: null,
                        url: `https://github.com/${login}/${login}`,
                    })
                    : Effect.fail(e),
            ),
        );
        const content = replaceProfileWidget(current.text, renderProfileWidget(input.profile));
        if (current.found && content === current.text) {
            return { status: "unchanged", url: current.url } satisfies ProfileWidgetResult;
        }
        const body: Record<string, unknown> = {
            message: "docs: update ax profile widget",
            content: Buffer.from(content, "utf8").toString("base64"),
        };
        if (current.sha !== null) body.sha = current.sha;

        const out = asRecord(yield* gh.api("PUT", path, body));
        const url = String(asRecord(out.content).html_url ?? `https://github.com/${login}/${login}`);
        return {
            status: current.found ? "updated" : "created",
            url,
        } satisfies ProfileWidgetResult;
    },
);
