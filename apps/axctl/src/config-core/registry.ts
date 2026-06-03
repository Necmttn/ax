import { Effect } from "effect";
import { AdapterNotFoundError } from "./errors.ts";

/** Anything a registry holds is addressable by a stable `name`. */
export interface NamedAdapter {
    readonly name: string;
}

export interface AdapterRegistry<A extends NamedAdapter> {
    /** All registered adapters, in declaration order. */
    readonly all: () => ReadonlyArray<A>;
    /** Look one up by name; fails with a typed error instead of `undefined`. */
    readonly select: (name: string) => Effect.Effect<A, AdapterNotFoundError>;
}

/**
 * Build the `{ all, select }` shape shared by every domain registry
 * (hook providers, skill sources, agent sources). `select` returns an Effect
 * that fails with `AdapterNotFoundError` rather than handing back `undefined` -
 * the same discipline as `ClassifierRegistry.select`. Each domain wraps the
 * result in its own `Context.Service` + `Layer.succeed`.
 */
export const makeRegistry = <A extends NamedAdapter>(
    domain: string,
    items: ReadonlyArray<A>,
): AdapterRegistry<A> => ({
    all: () => items,
    select: (name) => {
        const found = items.find((i) => i.name === name);
        return found
            ? Effect.succeed(found)
            : Effect.fail(
                new AdapterNotFoundError({
                    domain,
                    name,
                    known: items.map((i) => i.name),
                }),
            );
    },
});
