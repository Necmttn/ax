/** Hook decision, harness-agnostic. Adapters encode it per harness. */
export type Verdict =
  | { readonly _tag: "Allow" }
  | { readonly _tag: "Block"; readonly reason: string }
  | { readonly _tag: "Warn"; readonly message: string }
  | { readonly _tag: "Inject"; readonly context: string }
  | { readonly _tag: "Route"; readonly input: Record<string, unknown> };

export const Verdict = {
  allow: { _tag: "Allow" },
  block: (reason: string): Verdict => ({ _tag: "Block", reason }),
  warn: (message: string): Verdict => ({ _tag: "Warn", message }),
  inject: (context: string): Verdict => ({ _tag: "Inject", context }),
  /** Silently rewrite the tool input (PreToolUse allow + updatedInput). `input` is the FULL merged input. */
  route: (input: Record<string, unknown>): Verdict => ({ _tag: "Route", input }),
} as const;
