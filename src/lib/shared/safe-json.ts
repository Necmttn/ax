/**
 * Sync JSON.parse that returns null on parse failure. Defined here so
 * callers inside `Effect.gen` can use it without putting a `try/catch`
 * inside the generator body (the Effect language service flags TS15
 * `tryCatchInEffectGen` on any try/catch inside an Effect.gen).
 */
export function safeJsonParse<T>(s: string): T | null {
    try {
        return JSON.parse(s) as T;
    } catch {
        return null;
    }
}
