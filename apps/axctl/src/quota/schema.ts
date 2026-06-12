/**
 * Wire + snapshot types for Anthropic plan-quota usage (claude-meter parity).
 *
 * Source endpoint is the undocumented `api.anthropic.com/api/oauth/usage`
 * that the Claude Code CLI's own usage view reads (shape verified live
 * 2026-06-12). Decode is tolerant: unknown top-level fields are ignored and
 * every window is nullable, so endpoint drift degrades to missing tiles
 * instead of a hard failure.
 */
import { Option, Schema } from "effect";

export const QuotaWindowSchema = Schema.Struct({
    utilization: Schema.Number,
    resets_at: Schema.String,
});
export type QuotaWindow = typeof QuotaWindowSchema.Type;

const WireWindow = Schema.optional(Schema.NullOr(QuotaWindowSchema));

const WireExtraUsage = Schema.Struct({
    is_enabled: Schema.optional(Schema.NullOr(Schema.Boolean)),
    monthly_limit: Schema.optional(Schema.NullOr(Schema.Number)),
    used_credits: Schema.optional(Schema.NullOr(Schema.Number)),
    utilization: Schema.optional(Schema.NullOr(Schema.Number)),
});

export const UsageResponseSchema = Schema.Struct({
    five_hour: WireWindow,
    seven_day: WireWindow,
    seven_day_opus: WireWindow,
    seven_day_sonnet: WireWindow,
    extra_usage: Schema.optional(Schema.NullOr(WireExtraUsage)),
});
export type UsageResponse = typeof UsageResponseSchema.Type;

export const ExtraUsageStateSchema = Schema.Struct({
    is_enabled: Schema.Boolean,
    utilization: Schema.NullOr(Schema.Number),
    used_credits: Schema.NullOr(Schema.Number),
    monthly_limit: Schema.NullOr(Schema.Number),
});
export type ExtraUsageState = typeof ExtraUsageStateSchema.Type;

/**
 * Timestamped view of one usage fetch - the single shape every renderer
 * (table, statusline, SwiftBar, --json) and the on-disk cache consume.
 */
export const QuotaSnapshotSchema = Schema.Struct({
    v: Schema.Literal(1),
    fetched_at: Schema.String,
    five_hour: Schema.NullOr(QuotaWindowSchema),
    seven_day: Schema.NullOr(QuotaWindowSchema),
    seven_day_opus: Schema.NullOr(QuotaWindowSchema),
    seven_day_sonnet: Schema.NullOr(QuotaWindowSchema),
    extra_usage: Schema.NullOr(ExtraUsageStateSchema),
});
export type QuotaSnapshot = typeof QuotaSnapshotSchema.Type;

const decodeUsage = Schema.decodeUnknownOption(UsageResponseSchema);
const decodeSnapshot = Schema.decodeUnknownOption(QuotaSnapshotSchema);

export const decodeQuotaSnapshot = (raw: unknown): QuotaSnapshot | null => {
    const result = decodeSnapshot(raw);
    return Option.isSome(result) ? result.value : null;
};

const window = (w: QuotaWindow | null | undefined): QuotaWindow | null =>
    w == null ? null : { utilization: w.utilization, resets_at: w.resets_at };

/** Decode one raw usage-endpoint payload into a snapshot; null = unparseable. */
export const toQuotaSnapshot = (raw: unknown, fetchedAt: string): QuotaSnapshot | null => {
    const result = decodeUsage(raw);
    if (Option.isNone(result)) return null;
    const usage = result.value;
    const extra = usage.extra_usage;
    return {
        v: 1,
        fetched_at: fetchedAt,
        five_hour: window(usage.five_hour),
        seven_day: window(usage.seven_day),
        seven_day_opus: window(usage.seven_day_opus),
        seven_day_sonnet: window(usage.seven_day_sonnet),
        extra_usage:
            extra == null
                ? null
                : {
                    is_enabled: extra.is_enabled ?? false,
                    utilization: extra.utilization ?? null,
                    used_credits: extra.used_credits ?? null,
                    monthly_limit: extra.monthly_limit ?? null,
                },
    };
};
