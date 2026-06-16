// Allow `import schema from "@ax/schema/schema.surql" with { type: "text" }` (bun text loader).
declare module "*.surql" {
    const content: string;
    export default content;
}
