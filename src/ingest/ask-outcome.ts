export type UserAskKind =
    | "ui_improvement"
    | "verification_request"
    | "planning"
    | "data_ingestion"
    | "query_request"
    | "debug_fix"
    | "product_brainstorm"
    | "unknown";

export type FeedbackKind =
    | "approval"
    | "correction"
    | "friction"
    | "exploration"
    | "uncertainty"
    | "neutral";

const normalize = (text: string): string =>
    text
        .toLowerCase()
        .replace(/[^\w\s'-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();

const has = (text: string, pattern: RegExp): boolean => pattern.test(text);

export function classifyUserAsk(text: string): UserAskKind {
    const normalized = normalize(text);
    if (!normalized) return "unknown";

    const hasRequestCue = has(normalized, /\b(did|can you|could you|please|pls|run|make sure|confirm|prove)\b/);
    const hasInvestigativeDebugCue = has(normalized, /\b(why|failing|failure|error|bug|broken|debug|fix|issue|exception|crash|regression|wrong|diagnose)\b/);

    if (has(normalized, /\bdid you\b/) &&
        has(normalized, /\b(fix|debug|resolve|handle|address|confirm|prove)\b/)) {
        return "verification_request";
    }

    if (hasRequestCue && has(normalized, /\b(verify|verified|validate|validated)\b/)) {
        return "verification_request";
    }

    if (hasRequestCue && has(normalized, /\b(test|tested|check|checked)\b/) &&
        !(has(normalized, /\b(check|checked)\b/) && hasInvestigativeDebugCue)) {
        return "verification_request";
    }

    if (has(normalized, /\b(debug|fix|bug|broken|failing|failure|error|exception|crash|regression|wrong|issue|diagnose)\b/)) {
        return "debug_fix";
    }

    if (has(normalized, /\b(ui|visuals?|design|styling|styles?|layout|frontend|screen|view|polish|colors?|theme|dashboard)\b/) &&
        has(normalized, /\b(improve|better|make|update|change|polish|clean|nice|prettier|usable)\b/)) {
        return "ui_improvement";
    }

    if (has(normalized, /\b(plan|planning|approach|strategy|roadmap|spec|outline|breakdown)\b/) &&
        has(normalized, /\b(share|write|make|create|draft|lets?|let's|need|give)\b/)) {
        return "planning";
    }

    if (has(normalized, /\b(ingest|ingestion|import|backfill|sync|load|parse|extract|transcript|transcripts|sessions|schema|surreal|database|db)\b/) &&
        has(normalized, /\b(data|records?|rows?|files?|transcript|transcripts|sessions|schema|database|db|surreal|skill|skills)\b/)) {
        return "data_ingestion";
    }

    if (has(normalized, /\b(query|search|find|list|show|count|summarize|what|which|who|where|when|how many)\b/) &&
        has(normalized, /\b(skills?|tools?|sessions?|transcripts?|records?|data|usage|graph|nodes?|edges?|results?|me|my|the)\b/)) {
        return "query_request";
    }

    if (has(normalized, /\b(brainstorm|idea|ideas|what if|could we|can we|i wonder|explore|experiment|sentiment analysis|maybe)\b/)) {
        return "product_brainstorm";
    }

    return "unknown";
}

export function classifyFeedback(text: string): FeedbackKind {
    const normalized = normalize(text);
    if (!normalized) return "neutral";

    if (has(normalized, /^(yes|yep|yeah|yup|ok|okay|sure|approved|approve|ship it|looks good|lgtm|correct|right|exactly|perfect|great)$/)) {
        return "approval";
    }

    if (has(normalized, /\b(can you please|please do|please just|you need to|need you to|come on|why didn't|why did not|still not|again|just do)\b/)) {
        return "friction";
    }

    if (has(normalized, /\b(i wonder|what if|could we|can we|maybe we|explore|experiment|try|idea|brainstorm|sentiment analysis)\b/)) {
        return "exploration";
    }

    if (has(normalized, /\b(no|nope|nah|not that|not quite|wrong|actually|instead|rather|more like|i meant|meant|should be|should have|correction|fix that)\b/)) {
        return "correction";
    }

    if (has(normalized, /\b(maybe|not sure|unsure|uncertain|i think|i guess|probably|perhaps|might|confused)\b/)) {
        return "uncertainty";
    }

    return "neutral";
}
