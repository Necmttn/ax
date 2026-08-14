// Allow `import ddl from "./schema.duckdb.sql" with { type: "text" }` (bun text loader).
declare module "*.sql" {
    const content: string;
    export default content;
}
