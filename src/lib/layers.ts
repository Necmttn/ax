import { Layer } from "effect";
import { SurrealClientLive } from "./db.ts";

/**
 * Composed application layer. Currently only the SurrealDB client; future
 * services (config, logger, file system) merge in here.
 */
export const AppLayer = Layer.mergeAll(SurrealClientLive);
