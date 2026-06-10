import { describe, expect, test } from "bun:test";
import { ConfigProvider, Effect } from "effect";
import { dbEnvConfig } from "./db.ts";

/** Hermetic parse against an explicit env record (no process.env). */
const parse = (env: Record<string, string>) =>
    Effect.runSync(dbEnvConfig.parse(ConfigProvider.fromEnv({ env })));

describe("dbEnvConfig (envConfig back-compat shim)", () => {
    test("falls back to defaults when env is empty", () => {
        expect(parse({})).toEqual({
            url: "ws://127.0.0.1:8521",
            ns: "ax",
            db: "main",
            user: "root",
            pass: "root",
        });
    });

    test("honors env overrides", () => {
        expect(
            parse({
                AX_DB_URL: "ws://example:9999",
                AX_DB_NS: "ns-x",
                AX_DB_DB: "db-x",
                AX_DB_USER: "user-x",
                AX_DB_PASS: "pass-x",
            }),
        ).toEqual({
            url: "ws://example:9999",
            ns: "ns-x",
            db: "db-x",
            user: "user-x",
            pass: "pass-x",
        });
    });
});
