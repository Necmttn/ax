// apps/site/app/lib/challenge.ts
// Pure challenge/duel helpers - no React, no fetch, unit-testable.

const LOGIN_RE = /^[A-Za-z0-9-]{1,39}$/;

export type CompareDecision =
    | { kind: "invalid" }
    | { kind: "redirect"; to: string }
    | { kind: "overlay"; a: string; b: string };

/** Decide what /u/<a>/vs/<b> should do: reject bad logins, redirect self-compare,
 *  else overlay. Keeps the route component a thin renderer. */
export function compareDecision(a: string, b: string): CompareDecision {
    if (!LOGIN_RE.test(a) || !LOGIN_RE.test(b)) return { kind: "invalid" };
    if (a.toLowerCase() === b.toLowerCase()) return { kind: "redirect", to: `/u/${a}` };
    return { kind: "overlay", a, b };
}

export const duelPath = (a: string, b: string): string => `/u/${a}/vs/${b}`;

/** Bump when the duel OG render changes, to bust the image cache. */
export const DUEL_OG_REV = 1;

/** Absolute URL of the duel OG image for <meta og:image>. */
export const buildDuelOgImageUrl = (a: string, b: string): string =>
    `https://ax.necmttn.com/og-duel/${a}/${b}?r=${DUEL_OG_REV}`;

export interface DuelXIntentArgs {
    readonly a: string;
    readonly b: string;
    readonly aLeads: number;
    readonly total?: number;
    readonly origin: string;
}

/** X (twitter) web-intent URL prefilled with the lead line + absolute duel link. */
export function duelXIntent({ a, b, aLeads, total = 6, origin }: DuelXIntentArgs): string {
    const text = `@${a} leads @${b} on ${aLeads} of ${total} axes - think you can beat us?`;
    const url = `${origin}${duelPath(a, b)}`;
    return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
}
