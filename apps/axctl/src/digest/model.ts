import { Schema } from "effect";

export const DigestKind = Schema.Literals(["improve", "cost", "churn", "quota"]);
export type DigestKind = typeof DigestKind.Type;

/** Persisted ISO-string ⇄ Date codec that *rejects* malformed date strings on
 *  decode (a bare `DateFromString` would yield an `Invalid Date` instead). */
const IsoDate = Schema.DateFromString.check(Schema.isDateValid());

/** One ranked, renderable digest line. `id` is a stable key used for dedup. */
export class DigestItem extends Schema.Class<DigestItem>("DigestItem")({
  id: Schema.String,
  kind: DigestKind,
  salience: Schema.Number,
  text: Schema.String,
  action: Schema.String,
  evidence: Schema.optional(Schema.String),
  computed_at: IsoDate,
}) {}

/** A point-in-time ranked snapshot; store top-8, surface top-3. */
export class DigestSnapshot extends Schema.Class<DigestSnapshot>("DigestSnapshot")({
  generated_at: IsoDate,
  window_days: Schema.Number,
  items: Schema.Array(DigestItem),
}) {}

/** Parse persisted snapshot JSON; null on any parse/decode failure (callers
 *  treat null as "no snapshot" and stay silent). */
export const decodeSnapshotOrNull = (text: string): DigestSnapshot | null => {
  try {
    return Schema.decodeUnknownSync(DigestSnapshot)(JSON.parse(text));
  } catch {
    return null;
  }
};
