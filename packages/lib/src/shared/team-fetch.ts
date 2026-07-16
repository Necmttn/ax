import { type TeamProfileV1, validateTeamProfile } from "./team-community";

export interface GitHubFetchInit {
    readonly headers: Readonly<Record<string, string>>;
}

export interface GitHubResponse {
    readonly ok: boolean;
    readonly status: number;
    json(): Promise<unknown>;
}

export type GitHubFetch = (
    input: string,
    init: GitHubFetchInit,
) => Promise<GitHubResponse>;

export interface FetchTeamProfilesOptions {
    readonly org: string;
    readonly token: string;
    readonly fetch: GitHubFetch;
}

interface ContentsEntry {
    readonly name: string;
    readonly type: string;
}

const githubHeaders = (token: string): Readonly<Record<string, string>> => ({
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
});

function isContentsEntry(value: unknown): value is ContentsEntry {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const entry = value as Record<string, unknown>;
    return typeof entry.name === "string" && typeof entry.type === "string";
}

function isV1Envelope(value: unknown): boolean {
    return typeof value === "object"
        && value !== null
        && !Array.isArray(value)
        && (value as Record<string, unknown>).v === 1;
}

function decodeBase64Json(content: string): unknown {
    const binary = atob(content.replace(/\s/g, ""));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
}

async function fetchTeamProfile(
    url: string,
    token: string,
    githubFetch: GitHubFetch,
): Promise<TeamProfileV1> {
    const response = await githubFetch(url, { headers: githubHeaders(token) });
    if (!response.ok) throw new Error(`contents fetch failed (${response.status})`);

    const body = await response.json() as { readonly content?: unknown; readonly encoding?: unknown };
    if (body.encoding !== "base64" || typeof body.content !== "string") {
        throw new Error("contents response is not base64");
    }

    const decoded = decodeBase64Json(body.content);
    const profile = validateTeamProfile(decoded);
    if (!isV1Envelope(decoded)) throw new Error("invalid team profile version");
    return profile;
}

/**
 * Fetch all browser-readable team snapshots through GitHub's contents API.
 * A missing snapshot directory is empty; individual unreadable snapshots are
 * dropped so one developer's bad file cannot reject the team set.
 */
export async function fetchTeamProfiles(
    options: FetchTeamProfilesOptions,
): Promise<TeamProfileV1[]> {
    const org = encodeURIComponent(options.org);
    const baseUrl = `https://api.github.com/repos/${org}/ax-team/contents/.ax-team`;
    const listResponse = await options.fetch(baseUrl, {
        headers: githubHeaders(options.token),
    });
    if (listResponse.status === 404) return [];
    if (!listResponse.ok) throw new Error(`contents list failed (${listResponse.status})`);

    const listing = await listResponse.json();
    if (!Array.isArray(listing)) throw new Error("contents list is not an array");

    const entries = listing.filter(
        (entry): entry is ContentsEntry =>
            isContentsEntry(entry)
            && entry.type === "file"
            && entry.name.endsWith(".json"),
    );
    const settled = await Promise.allSettled(
        entries.map((entry) =>
            fetchTeamProfile(
                `${baseUrl}/${encodeURIComponent(entry.name)}`,
                options.token,
                options.fetch,
            )
        ),
    );

    return settled
        .filter((result): result is PromiseFulfilledResult<TeamProfileV1> =>
            result.status === "fulfilled"
        )
        .map((result) => result.value);
}
