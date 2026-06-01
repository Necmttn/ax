import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import contentCollections from "@content-collections/vite";

// Static-first prerender + SPA fallback. Pure static deploy target - no
// Cloudflare Worker, no SSR per request, no Worker bundle size limit. Deploy
// via `wrangler pages deploy dist/client --project-name=ax`.
//
// Every param-less route is rendered to its OWN static HTML at build time
// (full content, not a shell), so navigation is instant and SEO-complete.
// `autoStaticPathsDiscovery` (default) finds the static routes; `crawlLinks`
// then follows the fully-rendered pages to pick up enumerable dynamic routes -
// e.g. /docs renders a <Link> per ADR, so /docs/adr/$slug pages get
// prerendered too.
//
// The handful of genuinely runtime routes (/s/$owner/$gistId gist shares,
// /changelog/$version) aren't prerendered; `spa.enabled` emits an _shell.html
// that the `/* /index.html 200` rule falls back to, so they render client-side
// without a Worker.
//
// _redirects + public/install are honored at the Pages edge natively, so the
// install one-liner resolves without a Worker.
export default defineConfig({
  plugins: [
    contentCollections(),
    tanstackStart({
      srcDirectory: "app",
      // SPA mode keeps the client router + Link prefetch working on a static
      // host (no server). Prerender then statically renders each route's full
      // content on top, so first paint is static and in-app nav stays instant.
      //
      // maskPath drives WHICH route the SPA shell is rendered as (with an empty
      // body - the TSS_SHELL header strips route content via isShell). It
      // defaults to "/", which makes the shell page collide with the real "/"
      // page in the prerender dedup (paths are deduped by string, and the shell
      // wins) - so the homepage ships as the empty 2.5KB shell. We point maskPath
      // at "/old-landing" (a real, prerenderable but unlinked archive route) so
      // the shell renders a valid 200 neutral entry written to _shell.html (via
      // the default outputPath "/_shell"), WITHOUT colliding with the content
      // "/" page below. Trade-off: /old-landing loses its dedicated prerendered
      // HTML and is served client-side via the _redirects SPA fallback instead
      // (it is not linked from any nav, so SEO/LCP impact is nil). A synthetic
      // non-route maskPath does NOT work: it 404s during prerender, so no
      // _shell.html is written at all.
      spa: { enabled: true, maskPath: "/old-landing" },
      // Explicitly prerender the homepage to full static content. Without this,
      // the only "/" entry is the spa shell (pushed by post-build), so "/"
      // ships as the empty 2.5KB shell. Listing it here renders the real
      // landing markup to dist/client/index.html (cleanPagePath "/" ends in
      // "/" -> joinURL("/", "index.html")). `pages` is a top-level option
      // (sibling of `prerender`), not nested under it.
      pages: [{ path: "/", prerender: { enabled: true } }],
      prerender: {
        enabled: true,
        crawlLinks: true,
        failOnError: false,
      },
    }),
    // @vitejs/plugin-react MUST come after tanstackStart - the router
    // plugin tanstackStart pulls in must register first. Provides the
    // React Refresh runtime dev mode needs for client hydration.
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "~": new URL("./app", import.meta.url).pathname } },
});
