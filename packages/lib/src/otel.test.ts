import { describe, expect, test } from "bun:test";
import { ConfigProvider, Effect, Option } from "effect";
import { AX_OTLP_URL_ENV, otlpBaseUrlConfig } from "./otel.ts";

/** Hermetic parse against an explicit env record (no process.env). */
const parse = (env: Record<string, string>) =>
    Effect.runSync(otlpBaseUrlConfig.parse(ConfigProvider.fromEnv({ env })));

describe("otlpBaseUrlConfig (AX_OTLP_URL gate)", () => {
    test("unset -> none (telemetry layer stays empty)", () => {
        expect(Option.isNone(parse({}))).toBe(true);
    });

    test("empty string -> none (matches the old `baseUrl.length > 0` gate)", () => {
        expect(Option.isNone(parse({ [AX_OTLP_URL_ENV]: "" }))).toBe(true);
    });

    test("set -> some(url)", () => {
        expect(parse({ [AX_OTLP_URL_ENV]: "http://127.0.0.1:4318" })).toEqual(
            Option.some("http://127.0.0.1:4318"),
        );
    });
});
