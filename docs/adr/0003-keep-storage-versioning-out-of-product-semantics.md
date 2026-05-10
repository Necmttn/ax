# Keep storage versioning out of product semantics

`agentctl` may support SurrealKV as an experimental SurrealDB backend, but backend versioning will not be required for user-facing memory, tests, or graph queries. History such as superseded Change Sets and File Memories will be modeled explicitly with records and edges so the product behaves the same on RocksDB, SurrealKV, or any future supported backend.
