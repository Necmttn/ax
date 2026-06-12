/**
 * QuotaEnv - the single seam through which `ax quota` reads the Claude Code
 * OAuth token and calls the Anthropic usage endpoint. Live layer reads the
 * macOS Keychain (`Claude Code-credentials`, where the Claude Code CLI
 * stores its OAuth credentials) with a `~/.claude/.credentials.json`
 * fallback for Linux/older installs, then fetches
 * `api.anthropic.com/api/oauth/usage` with the Bearer token. ax never
 * refreshes the token - the running Claude Code CLI rotates it; we just
 * read whatever is current. Mirrors profile/github-env.ts.
 */
import { Context, Effect, Layer, Schema } from "effect";
import { decodeJsonOrNull } from "@ax/lib/decode";

export class QuotaApiError extends Schema.TaggedErrorClass<QuotaApiError>(
    "QuotaApiError",
)("QuotaApiError", {
    status: Schema.Number,
    message: Schema.String,
}) {}

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const KEYCHAIN_SERVICE = "Claude Code-credentials";

export interface QuotaEnvService {
    /** OAuth access token, or null when no Claude Code credentials exist. */
    readonly readToken: () => Effect.Effect<string | null>;
    /** Raw JSON body of the usage endpoint (decoded by quota/schema.ts). */
    readonly fetchUsage: (token: string) => Effect.Effect<unknown, QuotaApiError>;
}

export class QuotaEnv extends Context.Service<QuotaEnv, QuotaEnvService>()(
    "axctl/quota/QuotaEnv",
) {}

/** `{ claudeAiOauth: { accessToken } }` - shared shape of keychain + file creds. */
const tokenFromCredentialsJson = (raw: string): string | null => {
    const parsed = decodeJsonOrNull(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const oauth = (parsed as Record<string, unknown>).claudeAiOauth;
    if (typeof oauth !== "object" || oauth === null) return null;
    const token = (oauth as Record<string, unknown>).accessToken;
    return typeof token === "string" && token.length > 0 ? token : null;
};

const readTokenLive = async (): Promise<string | null> => {
    // macOS Keychain first - the canonical Claude Code credential store.
    try {
        const proc = Bun.spawnSync(
            ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
            { stdout: "pipe", stderr: "ignore" },
        );
        if (proc.exitCode === 0) {
            const token = tokenFromCredentialsJson(proc.stdout.toString().trim());
            if (token !== null) return token;
        }
    } catch {
        // `security` missing (non-macOS) - fall through to the file.
    }
    try {
        const file = Bun.file(`${process.env.HOME}/.claude/.credentials.json`);
        if (await file.exists()) return tokenFromCredentialsJson(await file.text());
    } catch {
        // unreadable file degrades to "no token"
    }
    return null;
};

const fetchUsageLive = async (token: string): Promise<unknown> => {
    let response: Response;
    try {
        response = await fetch(USAGE_URL, {
            headers: {
                Authorization: `Bearer ${token}`,
                "anthropic-beta": "oauth-2025-04-20",
            },
        });
    } catch (e) {
        throw new QuotaApiError({
            status: 0,
            message: e instanceof Error ? e.message : String(e),
        });
    }
    if (!response.ok) {
        throw new QuotaApiError({
            status: response.status,
            message: `GET ${USAGE_URL} -> HTTP ${response.status}`,
        });
    }
    const body = decodeJsonOrNull(await response.text());
    if (body === null) {
        throw new QuotaApiError({ status: 0, message: "usage endpoint returned non-JSON body" });
    }
    return body;
};

const liveShape: QuotaEnvService = {
    readToken: () =>
        Effect.promise(() => readTokenLive()).pipe(Effect.orElseSucceed(() => null)),
    fetchUsage: (token) =>
        Effect.tryPromise({
            try: () => fetchUsageLive(token),
            catch: (e) =>
                e instanceof QuotaApiError
                    ? e
                    : new QuotaApiError({ status: 0, message: e instanceof Error ? e.message : String(e) }),
        }),
};

export const QuotaEnvLive: Layer.Layer<QuotaEnv> = Layer.succeed(QuotaEnv, liveShape);

/**
 * Test layer: canned token + usage payload; records fetch calls. A `usage`
 * value of `{ __error: { status, message } }` injects a QuotaApiError.
 */
export const QuotaEnvTest = (config: {
    token: string | null;
    usage?: unknown;
}): { layer: Layer.Layer<QuotaEnv>; fetchCalls: string[] } => {
    const fetchCalls: string[] = [];
    const layer = Layer.succeed(QuotaEnv, {
        readToken: () => Effect.succeed(config.token),
        fetchUsage: (token) => {
            fetchCalls.push(token);
            const value = config.usage;
            if (typeof value === "object" && value !== null && "__error" in value) {
                const e = (value as { __error: { status: number; message: string } }).__error;
                return Effect.fail(new QuotaApiError({ status: e.status, message: e.message }));
            }
            return Effect.succeed(value);
        },
    });
    return { layer, fetchCalls };
};
