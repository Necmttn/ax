import { Effect } from "effect";
import { type TeamProfileV1, validateTeamProfile } from "@ax/lib/shared/team-community";
import {
    GitHubApiError,
    type GitHubEnvService,
} from "../profile/github-env.ts";

interface ContentsEntry {
    readonly name: string;
    readonly type: string;
}

const isContentsEntry = (value: unknown): value is ContentsEntry => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const entry = value as Record<string, unknown>;
    return typeof entry.name === "string" && typeof entry.type === "string";
};

const isV1Envelope = (value: unknown): boolean =>
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && (value as Record<string, unknown>).v === 1;

const decodeProfile = (value: unknown): TeamProfileV1 => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("contents response is not an object");
    }
    const { content, encoding } = value as Record<string, unknown>;
    if (encoding !== "base64" || typeof content !== "string") {
        throw new Error("contents response is not base64");
    }
    const binary = atob(content.replace(/\s/g, ""));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const decoded: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const profile = validateTeamProfile(decoded);
    if (!isV1Envelope(decoded)) throw new Error("invalid team profile version");
    return profile;
};

const decodeProfileEffect = (value: unknown) =>
    Effect.try({
        try: () => decodeProfile(value),
        catch: (error) => new GitHubApiError({
            status: 0,
            message: error instanceof Error ? error.message : String(error),
        }),
    });

export function readTeamSnapshots(
    github: GitHubEnvService,
    org: string,
): Effect.Effect<ReadonlyArray<TeamProfileV1>, GitHubApiError> {
    return Effect.gen(function* () {
        const encodedOrg = encodeURIComponent(org);
        const basePath = `/repos/${encodedOrg}/ax-team/contents/.ax-team`;
        const listing = yield* github.api("GET", basePath).pipe(
            Effect.catchIf(
                (error) => error.status === 404,
                () => Effect.succeed([]),
            ),
        );
        if (!Array.isArray(listing)) return [];

        const profiles: TeamProfileV1[] = [];
        const entries = listing.filter(
            (entry): entry is ContentsEntry =>
                isContentsEntry(entry)
                && entry.type === "file"
                && entry.name.endsWith(".json"),
        );
        for (const entry of entries) {
            const profile = yield* github
                .api("GET", `${basePath}/${encodeURIComponent(entry.name)}`)
                .pipe(
                    Effect.flatMap(decodeProfileEffect),
                    Effect.catch(() => Effect.succeed(null)),
                );
            if (profile !== null) profiles.push(profile);
        }
        return profiles;
    });
}
