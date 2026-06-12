# Effect v4 HttpRouter + HttpApi become the Insights Surface contract

The dashboard server's hand-rolled route table (`apps/axctl/src/dashboard/router/`)
is being replaced by Effect v4's layer-collected `HttpRouter` with an embedded
`HttpApi` definition - the **Insights Surface Contract** - living in
`@ax/lib/shared` (evolving `dashboard-types.ts` into Schemas). The contract is
the single source of truth: schema-decoded params/bodies/responses, typed error
schemas (replacing per-route ad-hoc `errorStatus` maps), Scalar docs mounted at
`/docs` (`HttpApiScalar.layer`, bundled script so it works offline), an OpenAPI
spec, and a generated `HttpApiClient` that the studio adopts per family as its
fetch layer - so daemon and studio can no longer drift.

## How

Strangler migration, one route family per PR (system → insights → sessions →
skills → improve → live), using the existing `dispatch() → null` fallthrough as
the seam; each family PR migrates the daemon routes AND swaps the studio's
hand-written fetches for the generated client. Two endpoints stay OUTSIDE the
contract as raw `HttpRouter` routes: SSE `/api/events` and binary `/api/image`
(streaming/binary shapes that don't fit `HttpApi`). Everything JSON-in/JSON-out
- including `POST /api/ingest` and `/api/version` - goes in the contract.

Prep landed first (this branch): one server-scoped runtime (`serve-runtime.ts`)
replaces the per-request `Effect.provide(AppLayer)` runner (which paid a fresh
SurrealDB WebSocket handshake per request) and the `ingest-state.ts` ambient
global. v4 `ManagedRuntime` caches a FAILED layer build forever, so the handle
self-heals: a rejection before `cachedContext` exists swaps in a fresh runtime,
preserving the old per-request runner's recover-when-DB-comes-up behavior.

## Trade-offs

- `effect/unstable/http` + `unstable/httpapi` namespaces on `effect@beta`: the
  API can move under us. Accepted - the repo is already pinned to the v4 beta
  everywhere else, and `.references/effect-smol` gives source-level lookup.
- Custom CORS stays partially hand-rolled: `HttpMiddleware.cors` covers
  origin/method/header handling (predicate origins), but Chrome's
  Private Network Access preflight (`Access-Control-Allow-Private-Network`)
  needs a thin custom middleware - the hosted studio fetching a loopback
  daemon depends on it.
- A long-lived runtime means a dropped SurrealDB connection after a successful
  build is NOT healed by the swap logic (same exposure as the MCP server's
  long-lived runtime); restart the daemon. The healing only covers builds that
  never succeeded.

## Effect RPC

`RpcServer.layerHttp` registers into the same layer-collected `HttpRouter`, so
RPC groups can mount beside the contract later without touching it. Considered
and deliberately NOT part of the Insights Surface Contract: RPC has no
OpenAPI/Scalar/curl story and no capability probing for daemon↔studio version
skew, and it does not replace the Durable Streams run-progress channel
(ADR-0007/0008 - RPC streams have no offset-resume). It is reserved for
ax-owned bidirectional seams where both ends version together - first
candidate: studio-desktop's Electron main↔backend IPC via the worker/socket
transports.
