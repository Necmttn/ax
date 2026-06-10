/** Hook decision, harness-agnostic. Adapters encode it per harness. */
export type Verdict =
  | { readonly _tag: "Allow" }
  | { readonly _tag: "Block"; readonly reason: string }
  | { readonly _tag: "Warn"; readonly message: string }
  | { readonly _tag: "Inject"; readonly context: string };

export const Verdict = {
  allow: { _tag: "Allow" },
  block: (reason: string): Verdict => ({ _tag: "Block", reason }),
  warn: (message: string): Verdict => ({ _tag: "Warn", message }),
  inject: (context: string): Verdict => ({ _tag: "Inject", context }),
} as const;
