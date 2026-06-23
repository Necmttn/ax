// Advice ledger model: parse the hook advice ledger JSONL (written by
// ~/.ax/hooks/advise-tap.ts) and the pure helpers for linking an advise to a
// dispatch outcome.
//
// Background: a PreToolUse hook on the Agent tool can only ADVISE (CC bugs
// #39814/#40580 exempt Agent from block/updatedInput). CC injects the advice as
// `additionalContext` but never writes it to the transcript, and the OTLP hook
// span carries no payload - so the advice is invisible to ax. The tap persists
// each fire (keyed by the `session_id` CC hands the hook on stdin) to
// ~/.ax/hooks/advise-log.jsonl; this module turns those rows into linkable graph
// records.

/** One parsed advice-ledger row. */
export interface AdviceRecord {
  /** ISO timestamp the tap stamped at fire time. */
  readonly ts: Date;
  /** The CC session_id the hook fired in (the PARENT/advised session). */
  readonly sessionId: string;
  /** Tool the hook matched (normally "Agent"). */
  readonly tool: string | null;
  /** The dispatch's tool_input.description - the join key to the `spawned` edge. */
  readonly description: string | null;
  /** "advise" when context was injected, "allow" otherwise. */
  readonly verdict: string;
  /** The injected additionalContext text (null on allow). */
  readonly adviceText: string | null;
  /** Cheaper tier the advice suggested, parsed from adviceText (null on allow). */
  readonly suggestedModel: string | null;
}

/**
 * Pull the suggested model tier out of an advice string. route-dispatch emits
 * "...re-dispatch with model:sonnet...". Returns the bare tier (lowercased) or
 * null when no `model:<tier>` token is present.
 */
export function parseSuggestedModel(adviceText: string | null): string | null {
  if (!adviceText) return null;
  const m = adviceText.match(/model:([a-z0-9][a-z0-9._-]*)/i);
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * Normalize a concrete model id to its tier label so a suggestion ("sonnet")
 * can be compared to an outcome ("claude-sonnet-4-6"). Unknown ids return the
 * id lowercased so an exact match can still bite.
 */
export function normalizeTier(model: string | null | undefined): string | null {
  if (!model) return null;
  const m = model.toLowerCase();
  if (m.includes("haiku")) return "haiku";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("opus")) return "opus";
  if (m.includes("fable")) return "fable";
  if (m.includes("gpt-5-nano") || m.includes("gpt-5.5-nano")) return "gpt-5-nano";
  if (m.includes("gpt-5-mini") || m.includes("gpt-5.5-mini")) return "gpt-5-mini";
  return m;
}

/** Frontier tiers an advise would route DOWN from. */
const FRONTIER_TIERS = new Set(["opus", "fable", "gpt-5", "gpt-5.5"]);

/**
 * Did the dispatch honor the advice? True when the child ran on the suggested
 * tier (or a non-frontier tier - the advice's intent was "drop off frontier").
 * `null` suggested or `null` child → null (can't judge).
 */
export function followedAdvice(
  suggested: string | null,
  childModel: string | null,
): boolean | null {
  if (!suggested || !childModel) return null;
  const childTier = normalizeTier(childModel);
  if (!childTier) return null;
  if (childTier === suggested) return true;
  // Honored-in-spirit: advice said route down, child landed on any non-frontier
  // tier (e.g. advised sonnet, ran haiku - still off Opus).
  return !FRONTIER_TIERS.has(childTier);
}

/**
 * Parse one advise-log JSONL line. Returns null for blank lines / malformed
 * JSON / rows missing a usable session_id+ts (can't be linked, so dropped).
 */
export function parseAdviceLine(line: string): AdviceRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  const sessionId = typeof raw.session_id === "string" ? raw.session_id : null;
  const tsStr = typeof raw.ts === "string" ? raw.ts : null;
  if (!sessionId || !tsStr) return null;
  const ts = new Date(tsStr);
  if (Number.isNaN(ts.getTime())) return null;

  const adviceText = typeof raw.injected === "string" ? raw.injected : null;
  const verdict = typeof raw.verdict === "string" ? raw.verdict : adviceText ? "advise" : "allow";
  return {
    ts,
    sessionId,
    tool: typeof raw.tool === "string" ? raw.tool : null,
    description: typeof raw.description === "string" ? raw.description : null,
    verdict,
    adviceText,
    suggestedModel: parseSuggestedModel(adviceText),
  };
}

/** Stable, idempotent record id so re-ingesting the append-only log never dupes. */
export function adviceRowKey(r: AdviceRecord): string {
  return Bun.hash(`${r.ts.getTime()}:${r.sessionId}:${r.description ?? ""}`).toString(16);
}

export const parseAdviceLog = (text: string): AdviceRecord[] =>
  text.split("\n").map(parseAdviceLine).filter((r): r is AdviceRecord => r !== null);
