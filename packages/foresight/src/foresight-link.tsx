import { useForesight } from "@foresightjs/react";
import { Link, useRouter } from "@tanstack/react-router";
import type { AnyRouter, LinkComponentProps, RegisteredRouter } from "@tanstack/react-router";
import type { ComponentProps, MouseEvent, ReactElement, ReactNode } from "react";
import { ledger } from "./ledger.ts";

type ForesightLinkExtraProps = {
    /** Warm the destination's data (e.g. queryClient.prefetchQuery thunk). */
    prefetchData?: () => Promise<unknown>;
    hitSlop?: number | { top: number; left: number; right: number; bottom: number };
    /** ms before the same element may prefetch again. Default 30s. */
    reactivateAfter?: number;
    /** Override the ledger/devtools key; defaults to to+params+search. */
    foresightName?: string;
};

/**
 * Typed like TanStack Router's own `LinkComponent` (per-callsite generics for
 * TFrom/TTo/params/search), not `ComponentProps<typeof Link>` - the latter
 * collapses generic inference so every route resolves to the same loose
 * reducer-fn shape at call sites instead of being checked against the route
 * tree.
 */
export type ForesightLinkComponent = <
    TRouter extends AnyRouter = RegisteredRouter,
    const TFrom extends string = string,
    const TTo extends string | undefined = undefined,
    const TMaskFrom extends string = TFrom,
    const TMaskTo extends string = "",
>(
    props: LinkComponentProps<"a", TRouter, TFrom, TTo, TMaskFrom, TMaskTo> & ForesightLinkExtraProps,
) => ReactElement;

// Internal props stay loosely typed (ComponentProps<typeof Link>) - the
// precise per-callsite generics only need to hold at the export boundary,
// where ForesightLinkImpl is cast to ForesightLinkComponent below.
export type ForesightLinkProps = ComponentProps<typeof Link> & ForesightLinkExtraProps;
type InternalLinkProps = ForesightLinkProps;

function stableStringify(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value ?? "");
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const body = keys
        .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
        .join(",");
    return `{${body}}`;
}

function stableKeyFrom(to: unknown, params: unknown, search: unknown): string {
    const base = typeof to === "string" ? to : stableStringify(to);
    const paramsPart = params ? `:${stableStringify(params)}` : "";
    const searchPart = search ? `:${stableStringify(search)}` : "";
    return `${base}${paramsPart}${searchPart}`;
}

function ForesightLinkImpl({
    prefetchData,
    hitSlop,
    reactivateAfter = 30_000,
    foresightName,
    onClick,
    ...linkProps
}: InternalLinkProps): ReactNode {
    const router = useRouter();
    const key = foresightName ?? stableKeyFrom(linkProps.to, linkProps.params, linkProps.search);

    const { elementRef } = useForesight<HTMLAnchorElement>({
        name: key,
        hitSlop,
        reactivateAfter,
        callback: () => {
            const tasks: Promise<unknown>[] = [
                router.preloadRoute({
                    to: linkProps.to,
                    params: linkProps.params,
                    search: linkProps.search,
                } as Parameters<typeof router.preloadRoute>[0]),
            ];
            if (prefetchData) tasks.push(prefetchData());
            for (const t of tasks) {
                t.catch(() => ledger.recordError(key, Date.now()));
            }
        },
    });

    return (
        <Link
            {...linkProps}
            ref={elementRef}
            onClick={(e: MouseEvent<HTMLAnchorElement>) => {
                onClick?.(e);
                // Consumer's onClick always runs first; only record a plain,
                // unmodified left-click that wasn't cancelled downstream.
                if (
                    !e.defaultPrevented &&
                    !e.metaKey &&
                    !e.ctrlKey &&
                    !e.shiftKey &&
                    !e.altKey &&
                    e.button === 0
                ) {
                    ledger.recordNavigate(key, Date.now());
                }
            }}
        />
    );
}

export const ForesightLink = ForesightLinkImpl as ForesightLinkComponent;

// Exported for direct unit testing (pure, DOM/router-free).
export { stableKeyFrom, stableStringify };
