import { useForesight } from "@foresightjs/react";
import { Link, useRouter } from "@tanstack/react-router";
import type { ComponentProps, MouseEvent, ReactNode } from "react";
import { ledger } from "./ledger.ts";

type LinkProps = ComponentProps<typeof Link>;

export type ForesightLinkProps = LinkProps & {
    /** Warm the destination's data (e.g. queryClient.prefetchQuery thunk). */
    prefetchData?: () => Promise<unknown>;
    hitSlop?: number | { top: number; left: number; right: number; bottom: number };
    /** ms before the same element may prefetch again. Default 30s. */
    reactivateAfter?: number;
    /** Override the ledger/devtools key; defaults to to+params. */
    foresightName?: string;
};

function stableKeyFrom(to: unknown, params: unknown): string {
    const base = typeof to === "string" ? to : JSON.stringify(to ?? "");
    return params ? `${base}:${JSON.stringify(params)}` : base;
}

export function ForesightLink({
    prefetchData,
    hitSlop,
    reactivateAfter = 30_000,
    foresightName,
    onClick,
    ...linkProps
}: ForesightLinkProps): ReactNode {
    const router = useRouter();
    const key = foresightName ?? stableKeyFrom(linkProps.to, linkProps.params);

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
                ledger.recordNavigate(key, Date.now());
                onClick?.(e);
            }}
        />
    );
}
