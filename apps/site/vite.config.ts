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
      spa: { enabled: true },
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
