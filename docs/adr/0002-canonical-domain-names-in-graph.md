# Use canonical domain names in the persisted graph

`agentctl` will use canonical domain names in SurrealDB even when shorter names are tempting: `repository` and `checkout` instead of ambiguous `repo` path language, `changeset` for a unit of work, and precise snake_case names such as `file_memory`, `code_ir`, `code_finding`, `has_checkout`, and `has_ir` where single-word names would become unclear. Node tables store durable identity, while edge tables store relationship-specific evidence such as edit paths, diff stats, import specifiers, and derivation links.
