import { Schema } from "effect";

const IsoDate = Schema.DateFromString.check(Schema.isDateValid());

export const UsageOrigin = Schema.Literals(["tty", "agent"]);
export type UsageOrigin = typeof UsageOrigin.Type;

export class UsageRecord extends Schema.Class<UsageRecord>("UsageRecord")({
  ts: IsoDate,
  command: Schema.String,
  flags: Schema.Array(Schema.String),
  exit_code: Schema.Number,
  duration_ms: Schema.Number,
  origin: UsageOrigin,
  repo_key: Schema.NullOr(Schema.String),
  ax_version: Schema.String,
}) {}

export const encodeUsageLine = (rec: UsageRecord): string =>
  JSON.stringify(Schema.encodeSync(UsageRecord)(rec));

export const parseUsageLine = (line: string): UsageRecord | null => {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return Schema.decodeUnknownSync(UsageRecord)(JSON.parse(trimmed));
  } catch {
    return null;
  }
};
