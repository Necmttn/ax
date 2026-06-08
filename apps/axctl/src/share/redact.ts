import { homedir } from "node:os";
import type { AxSessionShare } from "./artifact.ts";

export interface RedactionResult {
    readonly text: string;
    readonly rules: ReadonlyArray<string>;
}

const REDACTED_SECRET = "[REDACTED_SECRET]";
const SECRET_ASSIGNMENT_PATTERN = /\b((?=[A-Z_][A-Z0-9_]*=)[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*)(=)(?:"([^"]*)"|'([^']*)'|([^\s"'`]+))/gi;
const OPENAI_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]+/g;
const AUTHORIZATION_BEARER_PATTERN = /(Authorization:\s*Bearer\s+)([^\s"'`]+)/gi;
const GITHUB_TOKEN_PATTERN = /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/g;
const SLACK_TOKEN_PATTERN = /\bxox[a-z]-[A-Za-z0-9-]{20,}\b/g;
const AWS_ACCESS_KEY_ID_PATTERN = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const sortedRules = (rules: Iterable<string>): ReadonlyArray<string> => [...new Set(rules)].sort();

export function redactShareText(input: string): RedactionResult {
    const rules = new Set<string>();
    let text = input;

    const home = homedir();
    if (home && text.includes(home)) {
        text = text.replace(new RegExp(escapeRegExp(home), "g"), "~");
        rules.add("home-path");
    }

    text = text.replace(OPENAI_KEY_PATTERN, () => {
        rules.add("openai-api-key");
        return REDACTED_SECRET;
    });

    text = text.replace(AUTHORIZATION_BEARER_PATTERN, (_match, prefix: string) => {
        rules.add("authorization-bearer");
        return `${prefix}${REDACTED_SECRET}`;
    });

    text = text.replace(GITHUB_TOKEN_PATTERN, () => {
        rules.add("github-token");
        return REDACTED_SECRET;
    });

    text = text.replace(SLACK_TOKEN_PATTERN, () => {
        rules.add("slack-token");
        return REDACTED_SECRET;
    });

    text = text.replace(AWS_ACCESS_KEY_ID_PATTERN, () => {
        rules.add("aws-access-key-id");
        return REDACTED_SECRET;
    });

    text = text.replace(SECRET_ASSIGNMENT_PATTERN, (match, key: string, equals: string) => {
        rules.add("env-secret-assignment");
        const valueStart = `${key}${equals}`;
        const value = match.slice(valueStart.length);
        const quote = value.startsWith("\"") || value.startsWith("'") ? value[0] : "";

        return `${valueStart}${quote}${REDACTED_SECRET}${quote}`;
    });

    return {
        text,
        rules: sortedRules(rules),
    };
}

const redactValue = (value: unknown, appliedRules: Set<string>): unknown => {
    if (typeof value === "string") {
        const redacted = redactShareText(value);
        for (const rule of redacted.rules) appliedRules.add(rule);
        return redacted.text;
    }

    if (Array.isArray(value)) {
        return value.map((item) => redactValue(item, appliedRules));
    }

    if (typeof value === "object" && value !== null) {
        return Object.fromEntries(
            Object.entries(value).map(([key, nestedValue]) => [key, redactValue(nestedValue, appliedRules)]),
        );
    }

    return value;
};

/**
 * Redact one node's OWN content (everything except `children`) and stamp that
 * node's `redactions` with the rules that fired on it. Each node owns its
 * redaction state so that, once the bundle is split into per-session files,
 * every file accurately reports what was scrubbed in it - rather than every
 * child inheriting the root's flag (or claiming `applied: false` while its
 * text was in fact redacted).
 */
function redactNode(node: AxSessionShare): AxSessionShare {
    const { children, ...own } = node;
    const appliedRules = new Set<string>();
    const redactedOwn = redactValue(own, appliedRules) as Omit<AxSessionShare, "children">;
    const rules = sortedRules([...node.redactions.rules, ...appliedRules]);

    return {
        ...redactedOwn,
        ...(children ? { children: children.map(redactNode) } : {}),
        redactions: {
            applied: rules.length > 0,
            rules,
        },
    };
}

export function redactShareArtifact(artifact: AxSessionShare): {
    artifact: AxSessionShare;
    rules: ReadonlyArray<string>;
} {
    const redacted = redactNode(artifact);
    return { artifact: redacted, rules: redacted.redactions.rules };
}
