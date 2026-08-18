// Allow `import ddl from "./schema.duckdb.sql" with { type: "text" }` and
// `import surql from "./schema.surql" with { type: "text" }` (bun text
// loaders). Without these, packages/schema only typechecks inside the ROOT
// tsc program, where apps/axctl/src/types/surql.d.ts leaks its ambient
// declaration across the package boundary - so `tsc --noEmit` scoped to this
// package (its own package.json script, and any per-package turbo fan-out)
// failed on every .sql/.surql import.
declare module "*.sql" {
    const content: string;
    export default content;
}

declare module "*.surql" {
    const content: string;
    export default content;
}
