/**
 * Typed re-export of @ax/foresight's ForesightLink.
 *
 * The package types `ForesightLinkProps` via `ComponentProps<typeof Link>`,
 * which collapses TanStack Router's per-callsite generic inference (TFrom/TTo
 * default to string/undefined), so `to`/`params`/`search` stop being checked
 * against the route tree at call sites - every route resolves to the same
 * loose reducer-fn shape instead of a literal object. This re-export restores
 * that inference by typing the component like TanStack Router's own
 * `LinkComponent`, plus the ForesightLink-specific props. Runtime behavior is
 * untouched - types only. The real fix belongs in
 * packages/foresight/src/foresight-link.tsx (type it via `LinkComponent`/
 * `createLink` instead of `ComponentProps<typeof Link>`), which would apply
 * to every consumer, not just studio.
 */
import { ForesightLink as UntypedForesightLink } from "@ax/foresight";
import type { AnyRouter, LinkComponentProps, RegisteredRouter } from "@tanstack/react-router";
import type { ReactElement } from "react";

type ForesightLinkExtraProps = {
    prefetchData?: () => Promise<unknown>;
    hitSlop?: number | { top: number; left: number; right: number; bottom: number };
    reactivateAfter?: number;
    foresightName?: string;
};

export type ForesightLinkComponent = <
    TRouter extends AnyRouter = RegisteredRouter,
    const TFrom extends string = string,
    const TTo extends string | undefined = undefined,
    const TMaskFrom extends string = TFrom,
    const TMaskTo extends string = "",
>(
    props: LinkComponentProps<"a", TRouter, TFrom, TTo, TMaskFrom, TMaskTo> & ForesightLinkExtraProps,
) => ReactElement;

export const ForesightLink = UntypedForesightLink as ForesightLinkComponent;
