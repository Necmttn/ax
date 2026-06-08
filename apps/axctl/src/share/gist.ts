import { Effect, Schema } from "effect";
import { prettyPrint } from "@ax/lib/json";
import type { ShareBundle } from "./manifest.ts";

export interface GistRef {
    readonly owner: string;
    readonly gistId: string;
}

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

export function shareUrlForGist(ref: GistRef): string {
    return `https://ax.necmttn.com/s/${ref.owner}/${ref.gistId}`;
}

/**
 * GitHub Gists API create body. A multi-file gist is one POST with a `files`
 * map of name -> { content }, so the whole bundle publishes atomically. Note
 * the API has no per-file visibility: `public` applies to the whole gist.
 */
export function gistBundlePayload(input: {
    readonly bundle: ShareBundle;
    readonly public: boolean;
}): {
    readonly description: string;
    readonly public: boolean;
    readonly files: Record<string, { readonly content: string }>;
} {
    const files: Record<string, { content: string }> = {};
    for (const file of input.bundle.files) {
        files[file.name] = { content: prettyPrint(file.content) };
    }
    const id = input.bundle.manifest.session.id;
    return {
        description: `ax session share - ${id}`,
        public: input.public,
        files,
    };
}

/** `gh api` argv that POSTs a gist body from stdin and returns the JSON. */
export function gistApiArgs(): Array<string> {
    return ["gh", "api", "--method", "POST", "/gists", "--input", "-"];
}

/**
 * Parse `gh api /gists` JSON output into a GistRef. The response carries the
 * canonical `id` and `owner.login`; we tolerate a missing owner (anonymous
 * gists) by falling back to an empty owner the URL builder still accepts.
 */
export function parseGistApiOutput(output: string): GistRef | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(output);
    } catch {
        return null;
    }
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const gistId = typeof record.id === "string" ? record.id : null;
    if (gistId === null) return null;
    const ownerRecord = typeof record.owner === "object" && record.owner !== null
        ? record.owner as Record<string, unknown>
        : null;
    const owner = ownerRecord && typeof ownerRecord.login === "string" ? ownerRecord.login : "";
    return { owner, gistId };
}

export function createSessionGist(input: {
    readonly bundle: ShareBundle;
    readonly public: boolean;
}): Effect.Effect<GistRef, GistPublishError> {
    return Effect.tryPromise({
        try: async () => {
            const proc = Bun.spawn(gistApiArgs(), {
                stdin: "pipe",
                stdout: "pipe",
                stderr: "pipe",
            });

            proc.stdin.write(prettyPrint(gistBundlePayload(input)));
            proc.stdin.end();

            const [stdout, stderr, exitCode] = await Promise.all([
                new Response(proc.stdout).text(),
                new Response(proc.stderr).text(),
                proc.exited,
            ]);

            if (exitCode !== 0) {
                const message = stderr.trim() || stdout.trim() || `gh api /gists exited with code ${exitCode}`;
                throw new GistPublishError({ message });
            }

            const ref = parseGistApiOutput(stdout);
            if (ref === null) {
                throw new GistPublishError({
                    message: `Could not parse gist id from gh api output: ${stdout.trim().slice(0, 200)}`,
                });
            }

            return ref;
        },
        catch: toError,
    });
}
