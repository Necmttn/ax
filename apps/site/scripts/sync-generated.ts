import { createBuilder } from "@content-collections/core";
import { Generator, getConfig } from "@tanstack/router-generator";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Content transforms currently resolve repo-relative assets from apps/site.
process.chdir(siteRoot);

const contentBuilder = await createBuilder("content-collections.ts");
await contentBuilder.build();

const routerConfig = getConfig(
  {
    routesDirectory: "./app/routes",
    generatedRouteTree: "./app/routeTree.gen.ts",
    quoteStyle: "double",
    semicolons: true,
  },
  siteRoot,
);

const routerGenerator = new Generator({ config: routerConfig, root: siteRoot });
await routerGenerator.run();
