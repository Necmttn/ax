/**
 * Blog post OG card (1200x630 PNG).
 *
 * Renders purely from query params - the post page (blog_.$slug.tsx) knows the
 * title/date from its loader and passes them on the og:image URL, so this
 * function needs no content-collections access or manifest:
 *   /og-blog/<slug>?title=<encoded>&date=YYYY-MM-DD&r=<rev>
 *
 * Satori rules (same as the profile/share cards): display:flex everywhere,
 * integer px, margin-right not gap, no overflow/border-radius on tracks,
 * no raw svg, hex colors only (no rgb() - commas break the style parser),
 * no flex-wrap. Plain text in a fixed-width div wraps fine (it's text, not
 * flex children).
 */
import { ImageResponse } from "workers-og";
import {
  INK, PAPER, DIM, CARD, GREEN,
  esc, footerHtml, blockLogoHtml, loadOgFonts,
} from "../_lib/og-kit";

const MONTHS = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
] as const;

function fmtDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return "";
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${month} ${Number(m[3])}, ${m[1]}` : "";
}

export const onRequestGet: PagesFunction = async (ctx) => {
  const cache = (caches as unknown as { default: Cache }).default;
  const u = new URL(ctx.request.url);
  const cacheKey = new Request(u.toString());
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const rawTitle = (u.searchParams.get("title") ?? "").slice(0, 140).trim();
  const title = rawTitle.length > 0 ? rawTitle : "ax blog";
  const dateLabel = fmtDate(u.searchParams.get("date") ?? "");

  // Header: block logo left, kicker right.
  const logo = blockLogoHtml({ scale: 4, color: PAPER, dimColor: "transparent" });
  const kicker = `AX · FIELD NOTES${dateLabel ? ` · ${esc(dateLabel)}` : ""}`;
  const header = `<div style="display:flex;justify-content:space-between;align-items:center"><div style="display:flex">${logo}</div><span style="font-size:14px;letter-spacing:3px;color:${DIM}">${kicker}</span></div>`;

  // Title: large serif, wraps within the content width. Size steps down for
  // longer headlines so a long title still fits 630px tall.
  const titleSize = title.length > 80 ? 60 : title.length > 48 ? 72 : 88;
  const titleHtml = `<div style="display:flex;margin-top:48px"><div style="display:flex;width:1040px;font-family:'Gelasio';font-weight:700;font-size:${titleSize}px;line-height:1.08;color:${INK}">${esc(title)}</div></div>`;

  // Accent rule under the title (green = the house "live/earned" accent).
  const rule = `<div style="display:flex;margin-top:36px"><div style="display:flex;width:120px;height:8px;background:${GREEN}"></div></div>`;

  const inner = `<div style="display:flex;flex-direction:column">${header}${titleHtml}${rule}</div>`;
  const footer = footerHtml("ax.necmttn.com/blog · measured from local transcripts");
  const html = `<div style="display:flex;flex-direction:column;justify-content:space-between;width:1200px;height:630px;background:${CARD};padding:56px 64px;font-family:'JetBrains Mono'">${inner}${footer}</div>`;

  const { regular, bold, serif } = await loadOgFonts();

  let png: ArrayBuffer;
  try {
    const image = new ImageResponse(html, {
      width: 1200,
      height: 630,
      fonts: [
        { name: "JetBrains Mono", data: regular, weight: 400, style: "normal" },
        { name: "JetBrains Mono", data: bold, weight: 700, style: "normal" },
        { name: "Gelasio", data: serif, weight: 700, style: "normal" },
      ],
    });
    png = await image.arrayBuffer();
  } catch (err) {
    return new Response(
      `render error: ${err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err)}`,
      { status: 500 },
    );
  }
  if (png.byteLength === 0) return new Response("render produced 0 bytes", { status: 500 });

  const res = new Response(png, {
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=3600, s-maxage=3600",
    },
  });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
};
