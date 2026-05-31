import { Effect, Schema } from "effect";
import { prettyPrint } from "../lib/json.ts";
import type { AxSessionShare } from "./artifact.ts";

export interface GistRef {
    readonly owner: string;
    readonly gistId: string;
}

const GIST_URL_RE = /https:\/\/gist\.github\.com\/([^/\s]+)\/([^/\s?#]+)/;

class GistPublishError extends Schema.TaggedErrorClass<GistPublishError>(
    "GistPublishError",
)("GistPublishError", {
    message: Schema.String,
}) {}

const toError = (error: unknown): GistPublishError =>
    error instanceof GistPublishError
        ? error
        : new GistPublishError({
            message: error instanceof Error ? error.message : String(error),
        });

export function parseGistCreateOutput(output: string): GistRef | null {
    const match = output.match(GIST_URL_RE);
    if (match === null) return null;

    const [, owner, gistId] = match;
    if (owner === undefined || gistId === undefined) return null;

    return { owner, gistId };
}

export function shareUrlForGist(ref: GistRef): string {
    return `https://ax.necmttn.com/s/${ref.owner}/${ref.gistId}`;
}

export function gistCreateArgs(input: {
    readonly public: boolean;
}): Array<string> {
    return [
        "gh",
        "gist",
        "create",
        ...(input.public ? ["--public"] : []),
        "--filename",
        "ax-session.json",
        "-",
    ];
}

export function createSessionGist(input: {
    readonly artifact: AxSessionShare;
    readonly public: boolean;
}): Effect.Effect<GistRef, GistPublishError> {
    return Effect.tryPromise({
        try: async () => {
            const proc = Bun.spawn(gistCreateArgs({ public: input.public }), {
                stdin: "pipe",
                stdout: "pipe",
                stderr: "pipe",
            });

            proc.stdin.write(prettyPrint(input.artifact));
            proc.stdin.end();

            const [stdout, stderr, exitCode] = await Promise.all([
                new Response(proc.stdout).text(),
                new Response(proc.stderr).text(),
                proc.exited,
            ]);

            if (exitCode !== 0) {
                const message = stderr.trim() || stdout.trim() || `gh gist create exited with code ${exitCode}`;
                throw new GistPublishError({ message });
            }

            const ref = parseGistCreateOutput(stdout);
            if (ref === null) {
                throw new GistPublishError({
                    message: `Could not parse gist URL from gh output: ${stdout.trim()}`,
                });
            }

            return ref;
        },
        catch: toError,
    });
}
