export type TokenSourceQuality = "explicit" | "estimate" | "unavailable";
export type ModelSourceQuality = "explicit" | "unavailable";

export interface TokenQualityLabelInput {
    readonly source: string;
    readonly tokenSourceQuality: TokenSourceQuality;
    readonly tokenSourceDetail: string;
    readonly model: string | null;
    readonly modelSourceDetail?: string | null;
    readonly unpricedModelReason?: string | null;
}

export type TokenQualityLabels = Record<string, string | null>;

export const tokenQualityLabels = (input: TokenQualityLabelInput): TokenQualityLabels => ({
    source: input.source,
    token_source_quality: input.tokenSourceQuality,
    token_source_detail: input.tokenSourceDetail,
    model_source_quality: input.model ? "explicit" : "unavailable",
    model_source_detail: input.modelSourceDetail ?? (input.model ? "session_model" : "missing_model"),
    unpriced_model_reason: input.unpricedModelReason ?? "pricing_not_computed",
});

export const tokenQualityFromLabels = (
    labels: Record<string, unknown>,
    fallback: TokenSourceQuality,
): TokenSourceQuality => {
    const value = labels.token_source_quality;
    return value === "explicit" || value === "estimate" || value === "unavailable"
        ? value
        : fallback;
};

export const tokenSourceDetailFromLabels = (labels: Record<string, unknown>): string | null =>
    typeof labels.token_source_detail === "string" && labels.token_source_detail.length > 0
        ? labels.token_source_detail
        : null;

export const modelQualityFromLabels = (
    labels: Record<string, unknown>,
    hasModel: boolean,
): ModelSourceQuality => {
    const value = labels.model_source_quality;
    return value === "explicit" || value === "unavailable"
        ? value
        : hasModel
          ? "explicit"
          : "unavailable";
};

export const unpricedReasonFromLabels = (labels: Record<string, unknown>): string | null =>
    typeof labels.unpriced_model_reason === "string" && labels.unpriced_model_reason.length > 0
        ? labels.unpriced_model_reason
        : null;
