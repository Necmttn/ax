// Skill names can be plain (`composto`) or plugin-namespaced (`gsd:plan-phase`).
// SurrealDB record IDs ban `:` in default-form ids, so we encode them.

export function skillRecordKey(name: string): string {
    return name.replace(/:/g, "__");
}
