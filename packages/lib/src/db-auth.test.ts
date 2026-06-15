import { describe, expect, test } from "bun:test";
import { Effect, Redacted } from "effect";
import type { ConnectOptions } from "surrealdb";
import { acquire, connectOptions, type DbConfig, type SurrealLike } from "./db.ts";

const cfg: DbConfig = {
    url: "ws://127.0.0.1:8521",
    ns: "ax",
    db: "main",
    user: "root",
    pass: Redacted.make("s3cret"),
};

describe("connectOptions (regression for #431 - daemon loses auth mid-session)", () => {
    test("supplies credentials as the connect-time auth provider", () => {
        const opts = connectOptions(cfg);
        // Auth MUST ride on connect() (the SDK auth *provider*) rather than a
        // post-connect signin(). The provider is what the SDK replays on every
        // reconnect AND on the token-expiry renewal timer; a post-hoc signin()
        // sets authOverriden=true and disables that path, so once the root JWT
        // expires the session silently degrades to anonymous.
        expect(opts.authentication).toEqual({ username: "root", password: "s3cret" });
    });

    test("selects ns/db on connect so they replay on reconnect", () => {
        const opts = connectOptions(cfg);
        expect(opts.namespace).toBe("ax");
        expect(opts.database).toBe("main");
    });

    test("keeps WS auto-reconnect enabled", () => {
        expect(connectOptions(cfg).reconnect).toBe(true);
    });
});

describe("acquire wiring", () => {
    test("hands the credential-bearing options to connect() and never calls a bare signin", async () => {
        let connectUrl: string | undefined;
        let connectOpts: ConnectOptions | undefined;
        const calls: string[] = [];

        const fake: SurrealLike & { signin?: unknown; use?: unknown } = {
            connect: async (url: string, options?: ConnectOptions) => {
                calls.push("connect");
                connectUrl = url;
                connectOpts = options;
                return undefined;
            },
            close: async () => {
                calls.push("close");
                return undefined;
            },
            // Tripwires: the old buggy path called these post-connect.
            signin: () => {
                calls.push("signin");
            },
            use: () => {
                calls.push("use");
            },
        };

        const db = await Effect.runPromise(acquire(cfg, () => fake));
        expect(db).toBe(fake as unknown as typeof db);
        expect(connectUrl).toBe("ws://127.0.0.1:8521");
        expect(connectOpts?.authentication).toEqual({ username: "root", password: "s3cret" });
        // The fix routes auth through connect; no separate signin()/use() that
        // would mark the session authOverriden and break renewal.
        expect(calls).toEqual(["connect"]);
    });
});
