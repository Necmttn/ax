import type { GuardrailReceipts } from "./schema.ts";

export interface GuardrailHookEvidenceRow {
    readonly hook_name: string;
    readonly fires: number;
    readonly blocked: number;
    readonly warned: number;
}

export interface GuardrailVerdictRow {
    readonly verdict: string;
    readonly count: number;
}

const hookNameFromFile = (file: string): string | null => {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) return null;
    const name = file.replace(/\.ts$/, "");
    return name.length > 0 ? name : null;
};

const hookNameFromEvidence = (hookName: string): string => {
    const base = hookName.split(/[\\/]/).at(-1) ?? hookName;
    return base.replace(/\.(?:ts|js)$/, "");
};

export function deriveGuardrailReceipts(input: {
    readonly hookFiles: ReadonlyArray<string>;
    readonly hookEvidence: ReadonlyArray<GuardrailHookEvidenceRow>;
    readonly verdicts: ReadonlyArray<GuardrailVerdictRow>;
}): GuardrailReceipts | null {
    const hookNames = input.hookFiles
        .map(hookNameFromFile)
        .filter((name): name is string => name !== null)
        .sort((a, b) => a.localeCompare(b));

    const totals = new Map<string, { fires: number; blocked: number; warned: number }>();
    for (const name of hookNames) {
        totals.set(name, { fires: 0, blocked: 0, warned: 0 });
    }

    for (const row of input.hookEvidence) {
        const name = hookNameFromEvidence(row.hook_name);
        if (!totals.has(name)) continue;
        const prev = totals.get(name) ?? { fires: 0, blocked: 0, warned: 0 };
        totals.set(name, {
            fires: prev.fires + row.fires,
            blocked: prev.blocked + row.blocked,
            warned: prev.warned + row.warned,
        });
    }

    const verdicts = {
        worked: 0,
        did_not_work: 0,
        no_longer_needed: 0,
        partial: 0,
    };
    for (const row of input.verdicts) {
        if (row.verdict === "adopted") verdicts.worked += row.count;
        else if (row.verdict === "ignored" || row.verdict === "regressed") verdicts.did_not_work += row.count;
        else if (row.verdict === "no_longer_needed") verdicts.no_longer_needed += row.count;
        else if (row.verdict === "partial") verdicts.partial += row.count;
    }

    const hooks = [...totals.entries()].map(([name, t]) => ({
        name,
        fires: t.fires,
        blocked: t.blocked,
        warned: t.warned,
    }));
    const anyVerdict = verdicts.worked + verdicts.did_not_work + verdicts.no_longer_needed + verdicts.partial > 0;
    if (hooks.length === 0 && !anyVerdict) return null;

    return {
        hooks,
        verdicts: {
            worked: verdicts.worked,
            did_not_work: verdicts.did_not_work,
            no_longer_needed: verdicts.no_longer_needed,
            ...(verdicts.partial > 0 ? { partial: verdicts.partial } : {}),
        },
    };
}
