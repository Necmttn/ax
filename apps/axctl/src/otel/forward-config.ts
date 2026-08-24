/**
 * OTLP forwarding config (#1017, follow-up to #1014).
 *
 * `ax install --otel-forward` makes ax ADDITIVE instead of exclusive: the
 * harness points at ax's receiver, ax spools locally AND relays each body to
 * the user's own collector (the endpoint ax would otherwise have overwritten).
 *
 * This module is PURE - types, header parsing, and target resolution. The
 * install side writes the config; `otlpd` (`spool-server.ts`) loads it and
 * relays. No I/O here so the resolution logic stays unit-testable.
 *
 * The correctness heart is {@link resolveForwardTargets}: it forwards a signal
 * ONLY when ax's rewrite actually DIVERTS it to the loopback receiver. A signal
 * that still flows straight to the user's collector (e.g. an explicit
 * `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` ax never touches) is NOT forwarded -
 * forwarding it would DOUBLE-SEND the user's data.
 */

export type OtelSignal = "logs" | "metrics" | "traces";

export const OTEL_SIGNALS: readonly OtelSignal[] = ["logs", "metrics", "traces"];

export interface OtelForwardTarget {
    readonly signal: OtelSignal;
    /** Full destination URL (already carries the `/v1/<signal>` path). */
    readonly url: string;
    /** Auth/routing headers to replay (e.g. Datadog's `dd-api-key`). */
    readonly headers: Readonly<Record<string, string>>;
}

export interface OtelForwardConfig {
    readonly enabled: boolean;
    readonly created_at: string;
    readonly targets: readonly OtelForwardTarget[];
}

const trimEndpoint = (endpoint: string): string => endpoint.replace(/\/+$/, "");

// ax's receiver is always loopback; a target already on loopback is ax itself,
// never a user's collector - mirrors install-config's AX_LOOPBACK_RE.
const AX_LOOPBACK_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i;

export const isLoopbackEndpoint = (value: string): boolean =>
    AX_LOOPBACK_RE.test(value.trim());

const nonEmpty = (v: string | undefined): v is string => typeof v === "string" && v.trim() !== "";

/**
 * Parse an `OTEL_EXPORTER_OTLP_*_HEADERS` value: a comma-separated list of
 * `key=value` pairs (W3C Baggage form, per the OTEL env spec). Only the FIRST
 * `=` splits, so a value may itself contain `=`. Blank entries are skipped.
 */
export const parseOtlpHeaders = (raw: string | undefined): Record<string, string> => {
    if (!nonEmpty(raw)) return {};
    const out: Record<string, string> = {};
    for (const part of raw.split(",")) {
        const eq = part.indexOf("=");
        if (eq <= 0) continue;
        const key = part.slice(0, eq).trim();
        const value = part.slice(eq + 1).trim();
        if (key !== "") out[key] = value;
    }
    return out;
};

const signalKey = (signal: OtelSignal, suffix: "ENDPOINT" | "HEADERS"): string =>
    `OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_${suffix}`;

/**
 * Resolve the per-signal forward targets from the harness env AS IT WAS BEFORE
 * ax's rewrite. `env` is the pre-rewrite `settings.json` env block.
 *
 * A signal is forwarded when:
 *   1. its effective destination before ax was FOREIGN (non-loopback), AND
 *   2. ax's rewrite DIVERTS it to the loopback receiver.
 *
 * Divert rule (ax's `CC_ENV` writes the generic endpoint + an explicit LOGS
 * endpoint, but NOT explicit metrics/traces endpoints):
 *   - logs: ax always writes `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` -> ALWAYS diverted.
 *   - metrics/traces: ax writes only the generic endpoint, and an explicit
 *     per-signal endpoint out-ranks the generic in the OTEL SDK -> diverted
 *     ONLY when there is NO explicit per-signal endpoint.
 */
export const resolveForwardTargets = (
    env: Record<string, string> | undefined,
): OtelForwardTarget[] => {
    const e = env ?? {};
    const genericEndpoint = e.OTEL_EXPORTER_OTLP_ENDPOINT;
    const genericHeaders = parseOtlpHeaders(e.OTEL_EXPORTER_OTLP_HEADERS);
    const targets: OtelForwardTarget[] = [];

    for (const signal of OTEL_SIGNALS) {
        const explicit = e[signalKey(signal, "ENDPOINT")];
        const before = nonEmpty(explicit)
            ? explicit.trim()
            : nonEmpty(genericEndpoint)
                ? `${trimEndpoint(genericEndpoint.trim())}/v1/${signal}`
                : undefined;
        if (!before || isLoopbackEndpoint(before)) continue;

        const diverted = signal === "logs" ? true : !nonEmpty(explicit);
        if (!diverted) continue;

        const headers = { ...genericHeaders, ...parseOtlpHeaders(e[signalKey(signal, "HEADERS")]) };
        targets.push({ signal, url: before, headers });
    }
    return targets;
};

/** Build the on-disk config object from a resolved target list. */
export const buildForwardConfig = (
    targets: readonly OtelForwardTarget[],
    createdAtIso: string,
): OtelForwardConfig => ({
    enabled: targets.length > 0,
    created_at: createdAtIso,
    targets,
});

/** Map an OTLP request pathname (`/v1/logs`) to its signal, or null. */
export const signalOfPath = (pathname: string): OtelSignal | null => {
    for (const signal of OTEL_SIGNALS) {
        if (pathname === `/v1/${signal}`) return signal;
    }
    return null;
};

/** Narrow an unknown parsed JSON value to a usable OtelForwardConfig. */
export const asForwardConfig = (value: unknown): OtelForwardConfig | null => {
    if (typeof value !== "object" || value === null) return null;
    const v = value as Record<string, unknown>;
    if (!Array.isArray(v.targets)) return null;
    const targets: OtelForwardTarget[] = [];
    for (const t of v.targets) {
        if (typeof t !== "object" || t === null) continue;
        const tt = t as Record<string, unknown>;
        const signal = tt.signal;
        const url = tt.url;
        if ((signal !== "logs" && signal !== "metrics" && signal !== "traces") || typeof url !== "string") continue;
        const headers: Record<string, string> = {};
        if (typeof tt.headers === "object" && tt.headers !== null) {
            for (const [k, hv] of Object.entries(tt.headers as Record<string, unknown>)) {
                if (typeof hv === "string") headers[k] = hv;
            }
        }
        targets.push({ signal, url, headers });
    }
    return { enabled: v.enabled === true && targets.length > 0, created_at: String(v.created_at ?? ""), targets };
};
