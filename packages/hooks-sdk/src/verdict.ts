/** Hook decision, harness-agnostic. Adapters encode it per harness. */
export type Verdict =
  | { readonly _tag: "Allow" }
  | { readonly _tag: "Block"; readonly reason: string }
  | { readonly _tag: "Warn"; readonly message: string }
  | { readonly _tag: "Inject"; readonly context: string }
  | { readonly _tag: "Advise"; readonly context: string };

export const Verdict = {
  allow: { _tag: "Allow" },
  block: (reason: string): Verdict => ({ _tag: "Block", reason }),
  warn: (message: string): Verdict => ({ _tag: "Warn", message }),
  inject: (context: string): Verdict => ({ _tag: "Inject", context }),
  /** Emit additionalContext to the model (PreToolUse advisory, the only mechanism that reaches the model for Agent dispatches). */
  advise: (context: string): Verdict => ({ _tag: "Advise", context }),
} as const;
