/**
 * Shared OTLP signal seams (D - signal-flow unify).
 *
 * Extracts ONLY the genuinely-deep cross-signal machinery that was triplicated:
 *   - `harnessFromResource` + `harnessOf`  - the resource→harness lift (3×)
 *   - `walkResources`                       - the resource→scope iteration (3×),
 *     abstracting resource+scope+harness ONLY. The leaf (scope → rows) stays
 *     per-signal: metrics owns its metric→dataPoints fan-out, logs owns its
 *     allowlist filter - there is deliberately NO universal leaf walker.
 *   - `decodeSignal`                        - Schema decode → typed
 *     `OtelDecodeError` (the error stays in the TYPED channel; fail-open
 *     `orElseSucceed(null)` is applied at the handleOtlp dispatch seam, NEVER
 *     here - fail-open is byte-sensitive).
 *   - `writeRows`                           - the `rows.length ? exec : void`
 *     render-and-write body (3×). `stmt` receives `(row, i)` so the LOG record
 *     id index is computed at RENDER time over the post-allowlist-filter
 *     emitted array (metric/span stmts ignore `i`).
 *
 * The flat, greppable per-column UPSERT SQL is intentionally NOT abstracted into
 * a Column DSL (kept in writer.ts).
 */
import { Effect, Schema } from "effect";
import type { SurrealClient } from "@ax/lib/db";
import type { DbError } from "@ax/lib/errors";
import { executeStatements } from "@ax/lib/shared/surreal";
import { attrMap, type KeyValue } from "./otlp-schema.ts";

export type Signal = "metrics" | "traces" | "logs";

/** A flat attr lookup, as produced by `attrMap`. */
export type AttrMap = Map<string, string | number | boolean | null>;

/** The per-resource context shared by every signal's leaf: lifted attrs + harness. */
export interface ResourceCtx {
    readonly res: AttrMap;
    readonly harness: string;
}

/** Map an OTLP `service.name` to ax's harness label. Repeated 3× pre-unify. */
export const harnessOf = (
    serviceName: string | number | boolean | null | undefined,
): string => {
    if (serviceName === "claude-code" || serviceName === "claude_code") return "claude";
    if (serviceName === "codex_cli_rs") return "codex";
    if (serviceName === "opencode") return "opencode";
    if (typeof serviceName === "string" && serviceName.startsWith("pi")) return "pi";
    if (typeof serviceName === "string" && serviceName.startsWith("codex")) return "codex";
    return "unknown";
};

interface WithAttributes {
    // `| undefined` matches `Schema.optional` (the resource attr lists are decoded
    // via Schema.optional, which includes undefined under exactOptionalPropertyTypes).
    readonly attributes?: readonly KeyValue[] | undefined;
}

/** Lift a resource's attribute list into `{ res, harness }`. */
export const harnessFromResource = (
    resource: WithAttributes | undefined,
): ResourceCtx => {
    const res = attrMap(resource?.attributes);
    return { res, harness: harnessOf(res.get("service.name")) };
};

/**
 * Walk OTLP resource → scope, lifting each resource to `{ res, harness }`, and
 * concatenating each scope's emitted rows. The leaf `emit` stays per-signal.
 */
export const walkResources = <R, S, Row>(
    resources: readonly R[],
    getResource: (r: R) => WithAttributes | undefined,
    getScopes: (r: R) => readonly S[],
    emit: (ctx: ResourceCtx, scope: S) => readonly Row[],
): Row[] => {
    const out: Row[] = [];
    for (const r of resources) {
        const ctx = harnessFromResource(getResource(r));
        for (const scope of getScopes(r)) {
            for (const row of emit(ctx, scope)) out.push(row);
        }
    }
    return out;
};

/**
 * The typed-error decode seam. Keeps the failure in the TYPED `OtelDecodeError`
 * channel - fail-open is NOT applied here (it is applied once, at the dispatch
 * seam, so every signal swallows in exactly one place).
 */
export const decodeSignal = <S extends Schema.Top>(schema: S, signal: string) =>
(json: unknown): Effect.Effect<S["Type"], OtelDecodeError, S["DecodingServices"]> =>
    Schema.decodeUnknownEffect(schema)(json).pipe(
        Effect.mapError((e) => new OtelDecodeError({ signal, message: String(e) })),
    );

/**
 * Render rows to UPSERT statements and execute them; no statement for an empty
 * batch. `stmt` is called as `stmt(row, i)` over the post-filter emitted array,
 * so a per-payload `index` (logs) stays stable and collision-free.
 */
export const writeRows = <Row>(
    rows: readonly Row[],
    stmt: (row: Row, i: number) => string,
): Effect.Effect<void, DbError, SurrealClient> =>
    rows.length === 0 ? Effect.void : executeStatements(rows.map((r, i) => stmt(r, i)));

/** Typed decode failure. Lives here so `decodeSignal` has no import cycle. */
export class OtelDecodeError extends Schema.TaggedErrorClass<OtelDecodeError>(
    "OtelDecodeError",
)("OtelDecodeError", {
    signal: Schema.String,
    message: Schema.String,
}) {}
