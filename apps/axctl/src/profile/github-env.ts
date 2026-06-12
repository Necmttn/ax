/**
 * GitHubEnv - the single seam through which profile publish talks to
 * GitHub. Live layer shells out to `gh api` (auth handled by gh); the test
 * layer replays canned responses and records calls, so every publish
 * operation is testable without network. Mirrors hooks-sdk GitEnv.
 */
import { Context, Effect, Layer, Schema } from "effect";

export class GitHubApiError extends Schema.TaggedErrorClass<GitHubApiError>(
    "GitHubApiError",
)("GitHubApiError", {
    status: Schema.Number,
    message: Schema.String,
}) {}

export type GhMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface GitHubEnvService {
    /** `gh api --method <method> <path>` with optional JSON body on stdin. */
    readonly api: (
        method: GhMethod,
        path: string,
        body?: unknown,
    ) => Effect.Effect<unknown, GitHubApiError>;
    /** authenticated login, null when gh is missing/unauthenticated. */
    readonly login: () => Effect.Effect<string | null>;
}

export class GitHubEnv extends Context.Service<GitHubEnv, GitHubEnvService>()(
    "axctl/profile/GitHubEnv",
) {}

const ghApi = async (method: GhMethod, path: string, body?: unknown): Promise<unknown> => {
    const args = ["gh", "api", "--method", method, path, ...(body !== undefined ? ["--input", "-"] : [])];
    const proc = Bun.spawn(args, {
        stdin: body !== undefined ? "pipe" : "ignore",
        stdout: "pipe",
        stderr: "pipe",
    });
    if (body !== undefined && proc.stdin) {
        proc.stdin.write(JSON.stringify(body));
        proc.stdin.end();
    }
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    if (exitCode !== 0) {
        // gh prints "gh: Not Found (HTTP 404)" style messages on stderr.
        const m = /HTTP (\d{3})/.exec(stderr);
        throw new GitHubApiError({
            status: m ? Number(m[1]) : 1,
            message: stderr.trim() || stdout.trim() || `gh api ${path} exited ${exitCode}`,
        });
    }
    return stdout.trim() === "" ? null : JSON.parse(stdout);
};

const liveShape: GitHubEnvService = {
    api: (method, path, body) =>
        Effect.tryPromise({
            try: () => ghApi(method, path, body),
            catch: (e) =>
                e instanceof GitHubApiError
                    ? e
                    : new GitHubApiError({ status: 0, message: e instanceof Error ? e.message : String(e) }),
        }),
    login: () =>
        Effect.tryPromise({
            try: async () => {
                const proc = Bun.spawn(["gh", "api", "user", "--jq", ".login"], {
                    stdout: "pipe",
                    stderr: "ignore",
                });
                const out = await new Response(proc.stdout).text();
                return (await proc.exited) === 0 && out.trim() !== "" ? out.trim() : null;
            },
            catch: () => null,
        }).pipe(Effect.orElseSucceed(() => null)),
};

export const GitHubEnvLive: Layer.Layer<GitHubEnv> = Layer.succeed(GitHubEnv, liveShape);

export interface RecordedCall {
    readonly method: GhMethod;
    readonly path: string;
    readonly body?: unknown;
}

/** Test layer: canned responses keyed "METHOD path"; records every call. */
export const GitHubEnvTest = (config: {
    responses: Record<string, unknown>;
    login?: string | null;
}): { layer: Layer.Layer<GitHubEnv>; calls: RecordedCall[] } => {
    const calls: RecordedCall[] = [];
    const layer = Layer.succeed(GitHubEnv, {
        api: (method, path, body) => {
            calls.push(body !== undefined ? { method, path, body } : { method, path });
            const key = `${method} ${path}`;
            if (key in config.responses) return Effect.succeed(config.responses[key]);
            return Effect.fail(new GitHubApiError({ status: 404, message: `no canned response for ${key}` }));
        },
        login: () => Effect.succeed(config.login ?? null),
    });
    return { layer, calls };
};
