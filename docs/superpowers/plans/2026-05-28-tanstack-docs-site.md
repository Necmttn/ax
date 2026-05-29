# TanStack Start Docs Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-rolled `docs/index.html` + `docs/origin.html` with a single TanStack Start app under `site/` that also serves all existing markdown docs (ADRs, manifesto, language, brand, CLI reference, plus a new MDX-based "how ax sees your work" page powered by code-extracted stage rationales).

**Architecture:** Mirror the `~/Projects/usecontext.xyz` stack (TanStack Start + content-collections + MDX + shiki + Tailwind v4 + Cloudflare Pages). The `docs/` directory remains canonical source - content-collections reads it in place so AI agents, skills, and CLI tools (`ax improve accept`, retro briefs) keep working unchanged. A small generator script extracts `@rationale: <one-liner>` annotations from `src/ingest/*.ts` into a `.generated.mdx` partial that the new "how ax sees your work" page imports. Pages port one-for-one from HTML to TSX routes; animations port from vanilla canvas JS to React components.

**Tech Stack:**
- TanStack Start 1.166+ (React 19.2 + react-router under the hood)
- content-collections 0.14+ with `@content-collections/mdx`
- shiki 4.x (via `rehype-pretty-code`)
- Tailwind v4 via `@tailwindcss/vite`
- Cloudflare Pages via `@cloudflare/vite-plugin` + `wrangler`
- bun 1.3+ as runtime (matches main repo)

---

## File Structure

**New (created under `site/`):**

```
site/
├── package.json                         # separate workspace, own deps
├── tsconfig.json
├── vite.config.ts                       # tanstack-start + tailwind + content-collections + cloudflare
├── wrangler.jsonc                       # cloudflare pages config
├── content-collections.ts               # points at ../docs
├── app/
│   ├── client.tsx                       # tanstack-start client entry
│   ├── server.tsx                       # tanstack-start server entry
│   ├── router.tsx                       # router config
│   ├── routes/
│   │   ├── __root.tsx                   # layout, head, nav
│   │   ├── index.tsx                    # landing (was docs/index.html)
│   │   ├── origin.tsx                   # origin story (was docs/origin.html)
│   │   ├── manifesto.tsx                # renders docs/manifesto.md
│   │   ├── brand.tsx                    # renders docs/brand.md
│   │   ├── how-it-works.tsx             # imports docs/how-ax-sees-your-work.mdx
│   │   └── docs/
│   │       ├── index.tsx                # docs hub / TOC
│   │       ├── language.tsx             # renders docs/language.md
│   │       ├── cli-reference.tsx        # renders docs/insights-cli-reference.md
│   │       └── adr.$slug.tsx            # dynamic ADR route
│   ├── components/
│   │   ├── nav.tsx
│   │   ├── footer.tsx
│   │   ├── animations/                  # ported canvas components
│   │   │   ├── graph-canvas.tsx
│   │   │   └── (one per animation from docs/animations.js)
│   │   └── mdx-components.tsx           # shared MDX renderer (shiki, headings)
│   └── styles/
│       └── globals.css                  # tailwind base + ported pieces of site.css
└── public/                              # /images, /favicon, etc

scripts/
└── extract-stage-rationale.ts           # walks src/ingest/*.ts, emits .generated.mdx partial

docs/
└── how-ax-sees-your-work.mdx            # narrative scaffold, imports .generated.mdx
```

**Modified:**
- Root `package.json` - add `site` to workspace if monorepo, otherwise nothing
- Root `.gitignore` - add `site/dist`, `site/.tanstack`, `site/.wrangler`
- `docs/index.html`, `docs/origin.html`, `docs/site.css`, `docs/animations.js` - **deleted** in final task

**Source of truth preserved:**
- All `.md` files in `docs/` stay where they are. content-collections reads from `../docs` relative to `site/`. AI agents and skills keep reading raw markdown.

---

## Task 1: Scaffold the TanStack Start site

**Files:**
- Create: `site/package.json`
- Create: `site/tsconfig.json`
- Create: `site/vite.config.ts`
- Create: `site/app/client.tsx`
- Create: `site/app/server.tsx`
- Create: `site/app/router.tsx`
- Create: `site/app/routes/__root.tsx`
- Create: `site/app/routes/index.tsx` (stub)
- Create: `site/app/styles/globals.css`
- Modify: `.gitignore`

- [ ] **Step 1: Create `site/package.json`**

```json
{
  "name": "ax-site",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite dev",
    "build": "vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit",
    "deploy": "bun run build && wrangler pages deploy dist"
  },
  "dependencies": {
    "@tanstack/react-router": "^1.166.0",
    "@tanstack/react-start": "^1.166.0",
    "react": "^19.2.0",
    "react-dom": "^19.2.0"
  },
  "devDependencies": {
    "@cloudflare/vite-plugin": "^1.29.0",
    "@tailwindcss/vite": "^4.2.0",
    "@tanstack/router-devtools": "^1.166.0",
    "@types/node": "^25.0.0",
    "@types/react": "^19.2.0",
    "@types/react-dom": "^19.2.0",
    "tailwindcss": "^4.2.0",
    "typescript": "^5.6.0",
    "vite": "^5.4.0",
    "wrangler": "^3.78.0"
  }
}
```

- [ ] **Step 2: Create `site/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "preserve",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "paths": {
      "~/*": ["./app/*"]
    }
  },
  "include": ["app", "vite.config.ts", "content-collections.ts"]
}
```

- [ ] **Step 3: Create `site/vite.config.ts`**

```typescript
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [tanstackStart(), tailwindcss()],
  resolve: { alias: { "~": new URL("./app", import.meta.url).pathname } },
});
```

- [ ] **Step 4: Create `site/app/styles/globals.css`**

```css
@import "tailwindcss";

@theme {
  --color-bg: oklch(98% 0.005 80);
  --color-fg: oklch(20% 0.01 80);
  --font-sans: ui-sans-serif, system-ui, -apple-system, sans-serif;
  --font-mono: ui-monospace, "SF Mono", Menlo, monospace;
}

html, body { background: var(--color-bg); color: var(--color-fg); }
```

- [ ] **Step 5: Create `site/app/router.tsx`**

```typescript
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register { router: typeof router }
}
```

- [ ] **Step 6: Create `site/app/routes/__root.tsx`**

```typescript
import { Outlet, createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import "../styles/globals.css";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "ax - the agent experience layer" },
    ],
  }),
  component: () => (
    <html lang="en">
      <head><HeadContent /></head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  ),
});
```

- [ ] **Step 7: Create `site/app/routes/index.tsx` (stub)**

```typescript
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: () => <main className="p-8"><h1 className="text-4xl">ax - scaffolded</h1></main>,
});
```

- [ ] **Step 8: Create `site/app/client.tsx`**

```typescript
import { StartClient } from "@tanstack/react-start/client";
import { hydrateRoot } from "react-dom/client";
import { router } from "./router";

hydrateRoot(document, <StartClient router={router} />);
```

- [ ] **Step 9: Create `site/app/server.tsx`**

```typescript
import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { router } from "./router";

export default createStartHandler({ router })(defaultStreamHandler);
```

- [ ] **Step 10: Add `site/dist`, `site/.tanstack`, `site/.wrangler`, `site/node_modules` to `.gitignore`**

Append to root `.gitignore`:

```
site/dist
site/.tanstack
site/.wrangler
site/node_modules
site/app/routeTree.gen.ts
```

- [ ] **Step 11: Install deps + run dev**

```bash
cd site && bun install && bun run dev
```

Expected: vite starts on http://localhost:5173, page shows "ax - scaffolded". Stop with Ctrl-C.

- [ ] **Step 12: Commit**

```bash
git add site/ .gitignore
git commit -m "feat(site): scaffold tanstack-start docs app"
```

---

## Task 2: Wire content-collections to read `docs/`

**Files:**
- Modify: `site/package.json` (add content-collections deps)
- Create: `site/content-collections.ts`
- Modify: `site/vite.config.ts` (register plugin)
- Modify: `site/tsconfig.json` (path alias for `content-collections`)

- [ ] **Step 1: Add content-collections deps**

```bash
cd site && bun add @content-collections/core @content-collections/vite @content-collections/mdx rehype-pretty-code rehype-slug rehype-autolink-headings remark-gfm shiki
```

- [ ] **Step 2: Create `site/content-collections.ts`**

```typescript
import { defineCollection, defineConfig } from "@content-collections/core";
import { compileMDX } from "@content-collections/mdx";
import rehypePrettyCode from "rehype-pretty-code";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import remarkGfm from "remark-gfm";

const adrs = defineCollection({
  name: "adrs",
  directory: "../docs/adr",
  include: "*.md",
  schema: (z) => ({
    title: z.string().optional(),
  }),
  transform: async (doc, ctx) => {
    const body = await compileMDX(ctx, doc, {
      remarkPlugins: [remarkGfm],
      rehypePlugins: [rehypeSlug, [rehypePrettyCode, { theme: "github-dark" }], [rehypeAutolinkHeadings, { behavior: "wrap" }]],
    });
    const slug = doc._meta.fileName.replace(/\.md$/, "");
    const title = doc.title ?? slug.replace(/^\d+-/, "").replace(/-/g, " ");
    return { ...doc, slug, title, body };
  },
});

const pages = defineCollection({
  name: "pages",
  directory: "../docs",
  include: ["manifesto.md", "brand.md", "language.md", "insights-cli-reference.md"],
  schema: (z) => ({}),
  transform: async (doc, ctx) => {
    const body = await compileMDX(ctx, doc, {
      remarkPlugins: [remarkGfm],
      rehypePlugins: [rehypeSlug, [rehypePrettyCode, { theme: "github-dark" }], [rehypeAutolinkHeadings, { behavior: "wrap" }]],
    });
    const slug = doc._meta.fileName.replace(/\.md$/, "");
    return { ...doc, slug, body };
  },
});

export default defineConfig({ collections: [adrs, pages] });
```

- [ ] **Step 3: Update `site/vite.config.ts`**

```typescript
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import contentCollections from "@content-collections/vite";

export default defineConfig({
  plugins: [contentCollections(), tanstackStart(), tailwindcss()],
  resolve: { alias: { "~": new URL("./app", import.meta.url).pathname } },
});
```

- [ ] **Step 4: Add path alias for `content-collections` to tsconfig.json**

Replace the `paths` block in `site/tsconfig.json`:

```json
    "paths": {
      "~/*": ["./app/*"],
      "content-collections": ["./.content-collections/generated"]
    }
```

- [ ] **Step 5: Run dev to trigger content-collections build**

```bash
cd site && bun run dev
```

Expected: vite starts, logs "content-collections: built 5 documents" (or similar count matching `adrs/*.md` + 4 docs pages). Stop.

- [ ] **Step 6: Verify generated files exist**

```bash
ls site/.content-collections/generated/
```

Expected: `index.js` and `index.d.ts` present.

- [ ] **Step 7: Commit**

```bash
git add site/package.json site/bun.lock site/content-collections.ts site/vite.config.ts site/tsconfig.json
git commit -m "feat(site): wire content-collections to docs/ markdown"
```

---

## Task 3: Bind ADR + page routes that render from content-collections

**Files:**
- Create: `site/app/components/mdx-components.tsx`
- Create: `site/app/routes/docs/index.tsx`
- Create: `site/app/routes/docs/adr.$slug.tsx`
- Create: `site/app/routes/docs/language.tsx`
- Create: `site/app/routes/docs/cli-reference.tsx`
- Create: `site/app/routes/manifesto.tsx`
- Create: `site/app/routes/brand.tsx`

- [ ] **Step 1: Create `site/app/components/mdx-components.tsx`**

```typescript
import type { ComponentProps } from "react";

export const mdxComponents = {
  h1: (props: ComponentProps<"h1">) => <h1 className="text-3xl font-semibold mt-12 mb-4" {...props} />,
  h2: (props: ComponentProps<"h2">) => <h2 className="text-2xl font-semibold mt-10 mb-3" {...props} />,
  h3: (props: ComponentProps<"h3">) => <h3 className="text-xl font-semibold mt-8 mb-2" {...props} />,
  p: (props: ComponentProps<"p">) => <p className="leading-7 my-4" {...props} />,
  code: (props: ComponentProps<"code">) => <code className="font-mono text-sm bg-black/5 px-1 py-0.5 rounded" {...props} />,
  pre: (props: ComponentProps<"pre">) => <pre className="my-4 p-4 rounded-lg overflow-x-auto bg-black/90 text-white text-sm" {...props} />,
  a: (props: ComponentProps<"a">) => <a className="underline decoration-1 underline-offset-2" {...props} />,
};
```

- [ ] **Step 2: Create `site/app/routes/docs/index.tsx`**

```typescript
import { createFileRoute, Link } from "@tanstack/react-router";
import { allAdrs, allPages } from "content-collections";

export const Route = createFileRoute("/docs/")({
  loader: () => ({
    adrs: allAdrs.sort((a, b) => a.slug.localeCompare(b.slug)),
    pages: allPages,
  }),
  component: DocsIndex,
});

function DocsIndex() {
  const { adrs, pages } = Route.useLoaderData();
  return (
    <main className="max-w-3xl mx-auto p-8">
      <h1 className="text-3xl font-semibold mb-8">Docs</h1>
      <section className="mb-12">
        <h2 className="text-xl font-semibold mb-4">Reference</h2>
        <ul className="space-y-2">
          <li><Link to="/docs/language" className="underline">Language</Link></li>
          <li><Link to="/docs/cli-reference" className="underline">CLI reference</Link></li>
          <li><Link to="/manifesto" className="underline">Manifesto</Link></li>
          <li><Link to="/brand" className="underline">Brand</Link></li>
        </ul>
      </section>
      <section>
        <h2 className="text-xl font-semibold mb-4">Architecture Decision Records</h2>
        <ul className="space-y-2">
          {adrs.map((adr) => (
            <li key={adr.slug}>
              <Link to="/docs/adr/$slug" params={{ slug: adr.slug }} className="underline">{adr.title}</Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
```

- [ ] **Step 3: Create `site/app/routes/docs/adr.$slug.tsx`**

```typescript
import { createFileRoute, notFound } from "@tanstack/react-router";
import { MDXContent } from "@content-collections/mdx/react";
import { allAdrs } from "content-collections";
import { mdxComponents } from "~/components/mdx-components";

export const Route = createFileRoute("/docs/adr/$slug")({
  loader: ({ params }) => {
    const adr = allAdrs.find((a) => a.slug === params.slug);
    if (!adr) throw notFound();
    return { adr };
  },
  component: AdrPage,
});

function AdrPage() {
  const { adr } = Route.useLoaderData();
  return (
    <main className="max-w-3xl mx-auto p-8">
      <h1 className="text-3xl font-semibold mb-8">{adr.title}</h1>
      <article className="prose">
        <MDXContent code={adr.body} components={mdxComponents} />
      </article>
    </main>
  );
}
```

- [ ] **Step 4: Create `site/app/routes/docs/language.tsx`**

```typescript
import { createFileRoute, notFound } from "@tanstack/react-router";
import { MDXContent } from "@content-collections/mdx/react";
import { allPages } from "content-collections";
import { mdxComponents } from "~/components/mdx-components";

export const Route = createFileRoute("/docs/language")({
  loader: () => {
    const page = allPages.find((p) => p.slug === "language");
    if (!page) throw notFound();
    return { page };
  },
  component: () => {
    const { page } = Route.useLoaderData();
    return (
      <main className="max-w-3xl mx-auto p-8">
        <article className="prose">
          <MDXContent code={page.body} components={mdxComponents} />
        </article>
      </main>
    );
  },
});
```

- [ ] **Step 5: Create `site/app/routes/docs/cli-reference.tsx`**

Identical to Step 4 but with slug `"insights-cli-reference"` and route path `/docs/cli-reference`:

```typescript
import { createFileRoute, notFound } from "@tanstack/react-router";
import { MDXContent } from "@content-collections/mdx/react";
import { allPages } from "content-collections";
import { mdxComponents } from "~/components/mdx-components";

export const Route = createFileRoute("/docs/cli-reference")({
  loader: () => {
    const page = allPages.find((p) => p.slug === "insights-cli-reference");
    if (!page) throw notFound();
    return { page };
  },
  component: () => {
    const { page } = Route.useLoaderData();
    return (
      <main className="max-w-3xl mx-auto p-8">
        <article className="prose">
          <MDXContent code={page.body} components={mdxComponents} />
        </article>
      </main>
    );
  },
});
```

- [ ] **Step 6: Create `site/app/routes/manifesto.tsx`**

Identical pattern, slug `"manifesto"`, route `/manifesto`:

```typescript
import { createFileRoute, notFound } from "@tanstack/react-router";
import { MDXContent } from "@content-collections/mdx/react";
import { allPages } from "content-collections";
import { mdxComponents } from "~/components/mdx-components";

export const Route = createFileRoute("/manifesto")({
  loader: () => {
    const page = allPages.find((p) => p.slug === "manifesto");
    if (!page) throw notFound();
    return { page };
  },
  component: () => {
    const { page } = Route.useLoaderData();
    return (
      <main className="max-w-3xl mx-auto p-8">
        <article className="prose">
          <MDXContent code={page.body} components={mdxComponents} />
        </article>
      </main>
    );
  },
});
```

- [ ] **Step 7: Create `site/app/routes/brand.tsx`**

Same pattern, slug `"brand"`, route `/brand`. Inline body identical to Step 6 swapping slug + route.

- [ ] **Step 8: Run dev + spot-check each route**

```bash
cd site && bun run dev
```

Open in browser (or `curl -s http://localhost:5173/<route> | head -40`):
- `/docs` - lists ADRs and pages
- `/docs/adr/0010-pull-based-session-retros-via-reviewed-edge` - renders the new retro ADR
- `/docs/language` - renders language.md
- `/docs/cli-reference` - renders insights-cli-reference.md
- `/manifesto` - renders manifesto.md
- `/brand` - renders brand.md

Expected: each renders content with prose styling and code blocks highlighted. Stop dev.

- [ ] **Step 9: Commit**

```bash
git add site/app
git commit -m "feat(site): bind ADR + markdown page routes"
```

---

## Task 4: Port the landing page (`docs/index.html` → `site/app/routes/index.tsx`)

**Files:**
- Read: `docs/index.html` (1236 lines)
- Read: `docs/site.css` (4238 lines - extract sections used by index)
- Read: `docs/animations.js` (241 lines)
- Modify: `site/app/routes/index.tsx` (replace stub)
- Create: `site/app/components/animations/graph-canvas.tsx` (and siblings per animation)
- Create: `site/app/components/landing-sections/*.tsx` (one per major section if helpful)
- Modify: `site/app/styles/globals.css` (port landing-specific styles)

- [ ] **Step 1: Read all source files first**

Use Read on `docs/index.html`, `docs/site.css`, `docs/animations.js` in a single batched call. Identify:

- Section boundaries (hero, value props, demo, footer, etc.)
- Canvas IDs referenced by animations.js (`#graph-canvas`, etc.)
- CSS class scope: classes used by `index.html` vs classes only used by `origin.html`
- Inline scripts beyond animations.js

Produce a notes file `site/PORT-NOTES.md` (gitignored) with:
- Section list with line ranges
- Animation list with canvas IDs
- CSS to port to globals.css

- [ ] **Step 2: Port `docs/animations.js` to React components**

For each animation, create a component that mounts a `<canvas>`, runs the same draw loop inside a `useEffect`, and cleans up on unmount. Example for the first one:

```typescript
// site/app/components/animations/graph-canvas.tsx
import { useEffect, useRef } from "react";

export function GraphCanvas() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    // <inline the draw loop body from animations.js for this canvas id>
    let raf = 0;
    const tick = () => {
      // draw frame
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, []);
  return <canvas ref={ref} className="w-full h-full" />;
}
```

Repeat per animation in `docs/animations.js`. Keep the constants (`GREEN`, `BLUE`, `lerp`, `drawNode`, etc.) in a shared `site/app/components/animations/_primitives.ts` to avoid duplication.

- [ ] **Step 3: Port `docs/site.css` landing sections into Tailwind + globals.css**

Most landing styles become Tailwind utilities in JSX. Keep in `globals.css` only:
- CSS custom properties (theme colors, fonts)
- Global resets and base typography
- Anything that can't be expressed inline (e.g., complex selectors, prefers-reduced-motion blocks for animations)

Drop landing-only rules whose elements you'll render with Tailwind utilities instead.

- [ ] **Step 4: Replace `site/app/routes/index.tsx` with the full landing**

Translate each section of `docs/index.html` to JSX. Preserve copy verbatim - only the markup wrapper changes. Embed the animation components where the original `<canvas>` elements lived.

```typescript
import { createFileRoute } from "@tanstack/react-router";
import { GraphCanvas } from "~/components/animations/graph-canvas";
// import other animations

export const Route = createFileRoute("/")({
  component: Landing,
});

function Landing() {
  return (
    <main>
      <section className="hero">
        {/* hero copy from index.html */}
        <GraphCanvas />
      </section>
      {/* repeat each section */}
    </main>
  );
}
```

If the landing is long, split into `site/app/components/landing-sections/hero.tsx`, `value-props.tsx`, etc., and compose them in `Landing`.

- [ ] **Step 5: Visual diff against the original**

```bash
# in one terminal:
cd site && bun run dev
# in another:
python3 -m http.server --directory docs 8888
```

Open both `http://localhost:5173/` (new) and `http://localhost:8888/` (original) side by side. Walk every section. Note differences in PORT-NOTES.md; fix until they match (ignoring small font-rendering variance from inlined vs external fonts).

- [ ] **Step 6: Commit**

```bash
git add site/app/routes/index.tsx site/app/components site/app/styles
git commit -m "feat(site): port landing page from docs/index.html"
```

---

## Task 5: Port the origin story (`docs/origin.html` → `site/app/routes/origin.tsx`)

**Files:**
- Read: `docs/origin.html` (3458 lines)
- Read: `docs/site.css` (origin-specific sections only)
- Modify: `site/app/styles/globals.css` (port origin styles)
- Create: `site/app/routes/origin.tsx`
- Create: `site/app/components/origin-sections/*.tsx` (split big sections)

- [ ] **Step 1: Read source + identify section structure**

Read `docs/origin.html` and write `site/PORT-NOTES-ORIGIN.md` with:
- Top-level section list with line ranges
- Reusable patterns (chapter markers, pull quotes, etc.)
- Any embedded media (images, inline SVG, iframes)
- Any inline scripts

- [ ] **Step 2: Build section components per chapter**

Split origin.html into N section components by chapter (or top-level heading). Each component owns a chunk under ~300 lines of JSX so it's editable in isolation.

```typescript
// site/app/components/origin-sections/chapter-N-<topic>.tsx
export function ChapterN() {
  return (
    <section className="origin-chapter">
      {/* port the chapter HTML to JSX */}
    </section>
  );
}
```

- [ ] **Step 3: Compose `site/app/routes/origin.tsx`**

```typescript
import { createFileRoute } from "@tanstack/react-router";
import { ChapterOne } from "~/components/origin-sections/chapter-1-...";
// imports for each chapter

export const Route = createFileRoute("/origin")({
  component: Origin,
});

function Origin() {
  return (
    <main className="origin">
      <ChapterOne />
      {/* ...rest */}
    </main>
  );
}
```

- [ ] **Step 4: Visual diff against the original**

Same approach as Task 4 Step 5, comparing `http://localhost:5173/origin` against `http://localhost:8888/origin.html`. Walk every chapter. Reconcile.

- [ ] **Step 5: Commit**

```bash
git add site/app/routes/origin.tsx site/app/components/origin-sections site/app/styles
git commit -m "feat(site): port origin story from docs/origin.html"
```

---

## Task 6: Stage rationale annotation contract + extractor

**Files:**
- Create: `scripts/extract-stage-rationale.ts`
- Modify: One ingest stage file (pick `src/ingest/skills.ts` as the canonical example) to add the annotation
- Modify: `site/package.json` (add `prebuild`/`predev` to run the extractor)
- Create: `docs/how-ax-sees-your-work.generated.mdx` (output of extractor, gitignored)

- [ ] **Step 1: Define the annotation contract**

Each ingest stage file declares one structured comment header. Format:

```typescript
/**
 * @stage skills
 * @rationale Skills are the agent's standing instructions. Indexing
 * them up-front means later stages can ask "which skills *exist*"
 * without re-walking the filesystem on every query.
 * @inputs ~/.claude/skills/, ~/.agents/skills/, plugin caches
 * @outputs `skill` rows
 */
```

Required keys: `@stage <name>`, `@rationale <prose>`. Optional: `@inputs`, `@outputs`, `@order` (sort hint).

- [ ] **Step 2: Add the annotation to one ingest stage as the canonical example**

Pick `src/ingest/skills.ts`. Read its current top-of-file comment, replace with the structured block above (preserving any existing prose underneath).

- [ ] **Step 3: Write the extractor**

```typescript
// scripts/extract-stage-rationale.ts
#!/usr/bin/env bun
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

const SRC_DIR = "src/ingest";
const OUT_PATH = "docs/how-ax-sees-your-work.generated.mdx";

interface Stage {
  readonly name: string;
  readonly rationale: string;
  readonly inputs?: string;
  readonly outputs?: string;
  readonly order: number;
  readonly file: string;
}

const tagPattern = /@(stage|rationale|inputs|outputs|order)\s+([^\n]+(?:\n\s*\*\s+[^\n@*][^\n]*)*)/g;

const parseFile = async (file: string): Promise<Stage | null> => {
  const text = await readFile(file, "utf8");
  const headerMatch = text.match(/^\/\*\*([\s\S]*?)\*\//);
  if (!headerMatch) return null;
  const header = headerMatch[1];
  const tags: Record<string, string> = {};
  for (const m of header.matchAll(tagPattern)) {
    const [, key, raw] = m;
    tags[key] = raw.replace(/\n\s*\*\s+/g, " ").trim();
  }
  if (!tags.stage || !tags.rationale) return null;
  return {
    name: tags.stage,
    rationale: tags.rationale,
    inputs: tags.inputs,
    outputs: tags.outputs,
    order: tags.order ? Number.parseInt(tags.order, 10) : 999,
    file,
  };
};

const main = async () => {
  const files = await readdir(SRC_DIR);
  const stages: Stage[] = [];
  for (const name of files) {
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
    const stage = await parseFile(join(SRC_DIR, name));
    if (stage) stages.push(stage);
  }
  stages.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

  const sections = stages.map((s) => [
    `### ${s.name}`,
    ``,
    s.rationale,
    ``,
    s.inputs ? `**Inputs:** ${s.inputs}` : null,
    s.outputs ? `**Outputs:** ${s.outputs}` : null,
    `_Source: \`${s.file}\`_`,
    ``,
  ].filter(Boolean).join("\n"));

  const out = [
    `{/* GENERATED by scripts/extract-stage-rationale.ts - do not edit by hand. */}`,
    ``,
    ...sections,
  ].join("\n");

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, out, "utf8");
  console.log(`wrote ${stages.length} stages to ${OUT_PATH}`);
};

await main();
```

- [ ] **Step 4: Add `predev`/`prebuild` hooks**

Edit `site/package.json`:

```json
  "scripts": {
    "predev": "bun ../scripts/extract-stage-rationale.ts",
    "prebuild": "bun ../scripts/extract-stage-rationale.ts",
    "dev": "vite dev",
    "build": "vite build",
    ...
  }
```

- [ ] **Step 5: Gitignore the generated file**

Add to root `.gitignore`:

```
docs/how-ax-sees-your-work.generated.mdx
```

- [ ] **Step 6: Run the extractor**

```bash
bun scripts/extract-stage-rationale.ts
```

Expected: writes `docs/how-ax-sees-your-work.generated.mdx` with at least one stage section (`skills`).

- [ ] **Step 7: Commit**

```bash
git add scripts/extract-stage-rationale.ts src/ingest/skills.ts site/package.json .gitignore
git commit -m "feat(site): stage rationale annotation contract + extractor"
```

---

## Task 7: Write the "how ax sees your work" narrative MDX page

**Files:**
- Create: `docs/how-ax-sees-your-work.mdx`
- Create: `site/app/routes/how-it-works.tsx`
- Modify: `content-collections.ts` (add MDX collection for this file)

- [ ] **Step 1: Write `docs/how-ax-sees-your-work.mdx`**

```mdx
# How ax sees your work

This page walks the data flow once. Each ingest stage and reader has a
rationale stored next to its source file; this page assembles those
rationales in narrative order.

## The shape

Your Claude Code transcripts, Codex sessions, and installed skills get
ingested into a local SurrealDB. The graph is then read by a small set
of queries that drive the CLI, dashboard, and self-improvement loop.

## The stages

import StageRationales from "./how-ax-sees-your-work.generated.mdx";

<StageRationales />

## The readers

…(write reader rationale once you've added the same annotation contract
to query/reader files; for now this is a placeholder paragraph naming
the major reader surfaces - `ax improve list`, `ax retro pending`,
the dashboard insight views - and pointing readers at the CLI reference)

## Why this shape

Local-first because evidence is private. Graph because relationships
between turns / tools / files / commits / corrections are the
load-bearing primitive. SurrealQL because it gives us both document
and graph query in one DB without a second moving part. See the
ADR index for leaf-level decisions.
```

- [ ] **Step 2: Add MDX collection in content-collections.ts**

Append to `site/content-collections.ts`:

```typescript
import { defineCollection } from "@content-collections/core";

const howItWorks = defineCollection({
  name: "howItWorks",
  directory: "../docs",
  include: "how-ax-sees-your-work.mdx",
  schema: (z) => ({}),
  transform: async (doc, ctx) => {
    const body = await compileMDX(ctx, doc, {
      remarkPlugins: [remarkGfm],
      rehypePlugins: [rehypeSlug, [rehypePrettyCode, { theme: "github-dark" }], [rehypeAutolinkHeadings, { behavior: "wrap" }]],
    });
    return { ...doc, body };
  },
});
```

Add `howItWorks` to the `collections: [...]` array in the same file.

- [ ] **Step 3: Create the route**

```typescript
// site/app/routes/how-it-works.tsx
import { createFileRoute, notFound } from "@tanstack/react-router";
import { MDXContent } from "@content-collections/mdx/react";
import { allHowItWorks } from "content-collections";
import { mdxComponents } from "~/components/mdx-components";

export const Route = createFileRoute("/how-it-works")({
  loader: () => {
    const page = allHowItWorks[0];
    if (!page) throw notFound();
    return { page };
  },
  component: () => {
    const { page } = Route.useLoaderData();
    return (
      <main className="max-w-3xl mx-auto p-8">
        <article className="prose">
          <MDXContent code={page.body} components={mdxComponents} />
        </article>
      </main>
    );
  },
});
```

- [ ] **Step 4: Run dev, hit `/how-it-works`**

```bash
cd site && bun run dev
```

Expected: page renders the narrative scaffold with the stage section pulled from the generated MDX. Confirm `skills` stage shows.

- [ ] **Step 5: Commit**

```bash
git add docs/how-ax-sees-your-work.mdx site/app/routes/how-it-works.tsx site/content-collections.ts
git commit -m "feat(site): how ax sees your work narrative page"
```

---

## Task 8: Cloudflare Pages deploy config + sanity build

**Files:**
- Create: `site/wrangler.jsonc`
- Modify: `site/vite.config.ts` (Cloudflare plugin)

- [ ] **Step 1: Add Cloudflare Vite plugin**

```bash
cd site && bun add -d @cloudflare/vite-plugin
```

- [ ] **Step 2: Create `site/wrangler.jsonc`**

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "ax-site",
  "compatibility_date": "2026-05-01",
  "main": "./dist/_worker.js/index.js",
  "assets": { "directory": "./dist", "binding": "ASSETS" }
}
```

- [ ] **Step 3: Update `site/vite.config.ts`** to include the Cloudflare plugin:

```typescript
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import contentCollections from "@content-collections/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [contentCollections(), tanstackStart({ target: "cloudflare-pages" }), cloudflare(), tailwindcss()],
  resolve: { alias: { "~": new URL("./app", import.meta.url).pathname } },
});
```

- [ ] **Step 4: Run a production build locally**

```bash
cd site && bun run build
```

Expected: build completes, `dist/` directory created with `_worker.js/` and static assets.

- [ ] **Step 5: Preview**

```bash
cd site && bun run preview
```

Expected: preview server on http://localhost:4173 serving the built site. Spot-check `/`, `/origin`, `/docs`, `/manifesto`. Stop.

- [ ] **Step 6: Commit**

```bash
git add site/wrangler.jsonc site/vite.config.ts site/package.json site/bun.lock
git commit -m "feat(site): cloudflare pages deploy config"
```

---

## Task 9: Delete old static HTML/CSS/JS

**Files:**
- Delete: `docs/index.html`
- Delete: `docs/origin.html`
- Delete: `docs/site.css`
- Delete: `docs/animations.js`
- Modify: `docs/_redirects` (if it points to removed files, repoint to new routes or delete)

- [ ] **Step 1: Verify nothing else in the repo links to the removed files**

```bash
rg -l "docs/index\.html|docs/origin\.html|docs/site\.css|docs/animations\.js" --type=md --type=ts --type=json --type=html .
```

Expected: no hits outside the files about to be deleted. If there are hits, update them to point at the new routes (`/`, `/origin`, etc.) first.

- [ ] **Step 2: Check `docs/_redirects` content**

```bash
cat docs/_redirects 2>/dev/null
```

If it has rules pointing to `index.html` / `origin.html`, update them to point at `/` / `/origin`. If it's empty or only had legacy entries, delete it.

- [ ] **Step 3: Delete the files**

```bash
git rm docs/index.html docs/origin.html docs/site.css docs/animations.js
```

- [ ] **Step 4: Final visual check**

```bash
cd site && bun run dev
```

Walk `/`, `/origin`, `/docs`, `/docs/adr/<latest>`, `/docs/language`, `/docs/cli-reference`, `/manifesto`, `/brand`, `/how-it-works`. Confirm all render.

- [ ] **Step 5: Commit**

```bash
git commit -m "chore(site): retire docs/{index,origin}.html and shared static assets"
```

---

## Self-Review Notes

- **Spec coverage:** Tasks 1–3 cover scaffold + markdown rendering; Tasks 4–5 cover hand-rolled HTML pages; Task 6 covers the "rationale in code" extractor; Task 7 covers the new narrative page; Task 8 covers deploy; Task 9 cleans up. All five concerns from the conversation are mapped.
- **Parallelization (for subagent-driven execution):** Task 1 must complete first. Tasks 2 and 6 are independent of each other after Task 1. Tasks 3, 4, 5 are independent of each other after Task 2 (Task 4/5 don't strictly need content-collections, but rely on the scaffold). Task 7 depends on Tasks 2 and 6. Tasks 8 and 9 must come last.
- **Pre-flight before Task 4 and Task 5:** the source HTML is large (1236 / 3458 lines). The "Step 1: Read all source files first" step is non-negotiable; without it the subagent will sequence small reads and run out of context. Use batch-read-upfront.
- **Deferred:** OG image generation, RSS feed, sitemap generator, search, i18n. These are present in usecontext.xyz but not load-bearing for ax v0.1; add later as separate plans.
- **One concrete risk:** content-collections + TanStack Start interaction. If `vite dev` errors on the content-collections plugin order, swap plugin ordering. Both projects use the same versions usecontext.xyz uses, so this should hold, but flag it if it bites.
