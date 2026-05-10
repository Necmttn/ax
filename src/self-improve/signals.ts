export interface SignalInput {
    readonly sessions: readonly { readonly id: string; readonly project: string | null; readonly startedAt: string | null }[];
    readonly toolCalls: readonly {
        readonly sessionId: string;
        readonly commandNorm: string | null;
        readonly hasError: boolean;
        readonly ts: string;
    }[];
    readonly planSnapshots: readonly { readonly sessionId: string; readonly status?: string | null; readonly ts: string }[];
}

export interface DerivedSignal {
    readonly key: string;
    readonly kind: string;
    readonly subjectType: string;
    readonly subjectId: string;
    readonly text: string;
    readonly metrics: Record<string, number>;
    readonly evidenceIds: readonly string[];
    readonly ts: string;
}

function hashKey(value: string): string {
    return Bun.hash(value).toString(16).padStart(16, "0");
}

export function deriveRepeatedCommandFailureSignals(input: SignalInput, threshold = 3): DerivedSignal[] {
    const groups = new Map<string, typeof input.toolCalls>();
    for (const call of input.toolCalls) {
        if (!call.hasError || !call.commandNorm) continue;
        const key = `${call.sessionId}|${call.commandNorm}`;
        groups.set(key, [...(groups.get(key) ?? []), call]);
    }
    return [...groups.entries()]
        .filter(([, calls]) => calls.length >= threshold)
        .map(([key, calls]) => {
            const [sessionId, commandNorm] = key.split("|");
            return {
                key: `signal__${hashKey(key)}`,
                kind: "repeated_command_failure",
                subjectType: "command",
                subjectId: commandNorm,
                text: `Command ${commandNorm} failed ${calls.length} times in ${sessionId}.`,
                metrics: { failureCount: calls.length },
                evidenceIds: calls.map((call) => `${call.sessionId}:${call.ts}`),
                ts: calls.at(-1)?.ts ?? new Date(0).toISOString(),
            };
        });
}

export function deriveVerificationGapSignals(input: SignalInput): DerivedSignal[] {
    const verifyPattern = /\b(test|typecheck|lint|verify|check)\b/i;
    return input.sessions.flatMap((session) => {
        const calls = input.toolCalls.filter((call) => call.sessionId === session.id);
        const hadEdit = calls.some((call) => call.commandNorm === "apply_patch" || (call.commandNorm?.includes("git add") ?? false));
        const hadVerify = calls.some((call) => call.commandNorm !== null && call.commandNorm !== undefined && verifyPattern.test(call.commandNorm));
        if (!hadEdit || hadVerify) return [];
        return [{
            key: `signal__${hashKey(`${session.id}|missing_verification`)}`,
            kind: "missing_verification",
            subjectType: "session",
            subjectId: session.id,
            text: `Session ${session.id} changed files without a detected verification command.`,
            metrics: { editCommandCount: calls.length },
            evidenceIds: calls.map((call) => `${call.sessionId}:${call.ts}`),
            ts: calls.at(-1)?.ts ?? session.startedAt ?? new Date(0).toISOString(),
        }];
    });
}

export function deriveSignalsForSelfImprove(input: SignalInput): DerivedSignal[] {
    return [
        ...deriveRepeatedCommandFailureSignals(input),
        ...deriveVerificationGapSignals(input),
    ];
}
