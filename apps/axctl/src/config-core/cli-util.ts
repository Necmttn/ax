import { Option } from "effect";

/** Unwrap an optional CLI flag to `A | undefined`. Shared by the domain cli.ts. */
export const optionValue = <A>(value: Option.Option<A>): A | undefined =>
    Option.getOrUndefined(value);
