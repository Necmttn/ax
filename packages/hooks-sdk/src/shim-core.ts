/**
 * The daemon-first hook shim - EFFECT-FREE on the fast path.
 *
 * Installed as the hook command, it POSTs the harness event to the running
 * `ax serve` daemon's `/hooks/eval` (warm, ~1ms) and applies the returned
 * ProcessOutcome - skipping the cold `bun` spawn + ~0.9 MB effect-bundle parse
 * the spawned dispatcher pays per fire. If the daemon is unreachable or errors,
 * it LAZY-imports the sibling dispatch bundle and runs the guards locally, so
 * enforcement still works offline. The dynamic import keeps effect off the fast
 * path: the fat bundle is only loaded on the fallback.
 *
 * No effect / no @ax/hooks-sdk runtime imports here - this file (and the tiny
 * bundle of it) must stay dependency-light so the fast path is just a fetch.
 */

/** Bypass flags + spend mode the daemon can't see in its own process.env. The
 *  shim runs in the AGENT's process, so it forwards these into the payload. */
export const FORWARDED_ENV_KEYS = [
    "ALLOW_MAIN_WRITE",
    "ALLOW_BRANCH_CHECKOUT",
    "ALLOW_DIRTY_MAIN_MUTATION",
    "AX_SPEND_MODE",
] as const;

const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Inject an `_ax_env` allowlist (from the agent's env) into the harness event
 * JSON so a daemon-evaluated guard honors the agent's bypass flags. Returns the
 * stdin UNCHANGED when it isn't a JSON object (the daemon's decode handles
 * that) or when nothing in the allowlist is set.
 */
export const withForwardedEnv = (
    stdinText: string,
    env: Record<string, string | undefined>,
    keys: ReadonlyArray<string> = FORWARDED_ENV_KEYS,
): string => {
    let obj: unknown;
    try {
        obj = JSON.parse(stdinText);
    } catch {
        return stdinText;
    }
    if (!isObject(obj)) return stdinText;
    const fwd: Record<string, string> = {};
    for (const k of keys) {
        const v = env[k];
        if (typeof v === "string") fwd[k] = v;
    }
    if (Object.keys(fwd).length === 0) return stdinText;
    return JSON.stringify({ ...obj, _ax_env: fwd });
};

/** The hook process contract: exit code + optional streams. */
export interface DaemonOutcome {
    readonly exitCode: number;
    readonly stdout?: string;
    readonly stderr?: string;
}

/** A daemon body is usable only if it carries a numeric exitCode. */
export const isDaemonOutcome = (v: unknown): v is DaemonOutcome =>
    isObject(v) && typeof v["exitCode"] === "number";

/** The daemon URL from an explicit port / AX_SERVE_PORT / the default 1738. */
export const hookEvalUrl = (
    env: Record<string, string | undefined>,
    port?: string,
): string => `http://127.0.0.1:${port ?? env.AX_SERVE_PORT ?? "1738"}/hooks/eval`;

export interface RunShimOptions {
    /** URL/path of the sibling dispatch bundle to import on fallback. */
    readonly fallbackUrl: URL | string;
    readonly port?: string;
}

/**
 * Fast path: POST the (env-forwarded) event to the daemon and apply its
 * outcome. Fallback: import the sibling dispatch bundle and run it locally with
 * the already-read stdin. Exits the process either way (a hook emits exactly
 * one outcome).
 */
export const runShim = async (opts: RunShimOptions): Promise<void> => {
    const env = process.env as Record<string, string | undefined>;
    const stdin = await Bun.stdin.text();
    const timeoutMs = Number(env.AX_HOOK_TIMEOUT_MS ?? "2000");
    try {
        const res = await fetch(hookEvalUrl(env, opts.port), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: withForwardedEnv(stdin, env),
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) {
            const outcome: unknown = await res.json();
            if (isDaemonOutcome(outcome)) {
                if (outcome.stdout) process.stdout.write(outcome.stdout);
                if (outcome.stderr) process.stderr.write(outcome.stderr);
                process.exit(outcome.exitCode);
            }
        }
    } catch {
        // daemon down / timeout / bad body -> fall through to the local bundle.
    }
    const mod = (await import(String(opts.fallbackUrl))) as {
        runDispatchFromStdin: (stdinText: string) => Promise<void>;
    };
    await mod.runDispatchFromStdin(stdin);
};
