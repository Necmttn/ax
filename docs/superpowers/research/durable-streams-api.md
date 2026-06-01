# Durable Streams API - pinned reference (Task 0 research spike)

Status: **verified against installed `.d.ts` + a live end-to-end spike run**.
Everything below is copied from the real packages, not invented. Quick-glance
decision at the bottom: **(B) Sidecar**.

## Resolved packages + versions

Installed into `apps/axctl` via `bun add @durable-streams/client @durable-streams/server`:

| Package | Version | Notes |
|---|---|---|
| `@durable-streams/server` | `0.3.5` | reference Node server. Transitive deps: `@durable-streams/client@0.2.6`, `@durable-streams/state@0.2.9`, `@neophi/sieve-cache`, `lmdb@^3.3.0` (native, used only in file-backed mode). |
| `@durable-streams/client` | `0.2.6` | TS client. Deps: `@microsoft/fetch-event-source`, `fastq`. |

These ARE the correct published names (Electric SQL's Durable Streams). Both
are ESM-first (`"type": "module"`), single entrypoint `.`, `dist/index.d.ts`.
Apache-2.0.

> Note on install layout: bun used its **isolated store**, so the packages live
> under `node_modules/.bun/@durable-streams+*/node_modules/@durable-streams/*`
> (not a flat `node_modules/@durable-streams/`). They resolve normally from
> code inside `apps/axctl`. A plain `bun run` of a script in `/tmp` cannot
> resolve them - run spike scripts from inside `apps/axctl`.

---

## Spike result (ran for real, 2026-06-02)

A throwaway script started an in-memory server, created a stream, appended two
JSON events, did a catch-up read, then resumed from the returned offset and
read only the newer event. Output:

```
server.start() returned: http://127.0.0.1:58200
server.url: http://127.0.0.1:58200
stream url: http://127.0.0.1:58200/ingest:run-123
catch-up items: [{"step":"discover","status":"start"},{"step":"discover","status":"done"}]
res.offset after catch-up: 0000000000000000_0000000000000083
resumed items: [{"step":"ingest","status":"start"}]
OK
```

Confirms: the stream **path is the stream key** (we used `/ingest:run-123`),
catch-up returns all prior items, `res.offset` is an opaque
`"<read-seq>_<byte-offset>"` string, and passing it back as `offset` resumes
without replay. This is exactly the catch-up + live + resume shape Task 3/4
need.

---

## SERVER API (`@durable-streams/server`)

### What is exported (verbatim export list from `dist/index.d.ts`)

```
CursorOptions, DEFAULT_CURSOR_EPOCH, DEFAULT_CURSOR_INTERVAL_SECONDS,
DurableStreamTestServer, FileBackedStreamStore, PendingLongPoll, Stream,
StreamLifecycleEvent, StreamLifecycleHook, StreamMessage, StreamStore,
SubscriptionCallbackRequest, SubscriptionCreateInput, SubscriptionError,
SubscriptionErrorCode, SubscriptionManager, SubscriptionRecord,
SubscriptionRoutes, SubscriptionStatus, SubscriptionStreamInfo,
SubscriptionStreamLink, SubscriptionType, TestServerOptions,
calculateCursor, createRegistryHooks, decodeStreamPath, encodeStreamPath,
generateResponseCursor, globMatch, handleCursorCollision, validateWebhookUrl
```

### The HTTP server: `DurableStreamTestServer`

This is the **only** thing that turns HTTP requests into stream operations, and
it owns its own Node `http.Server`. Verbatim shape (`.d.ts`):

```ts
interface TestServerOptions {
  port?: number;                          // Default: 0 (auto-assign) per .d.ts
  host?: string;                          // Default: "127.0.0.1"
  longPollTimeout?: number;               // Default: 30000 (ms)
  dataDir?: string;                       // file-backed (LMDB) if set; in-memory if omitted
  onStreamCreated?: StreamLifecycleHook;
  onStreamDeleted?: StreamLifecycleHook;
  compression?: boolean;                  // Default: true
  cursorIntervalSeconds?: number;         // Default: 20
  cursorEpoch?: Date;
  webhooks?: boolean;                     // Default: false
}

declare class DurableStreamTestServer {
  readonly store: StreamStore | FileBackedStreamStore;
  constructor(options?: TestServerOptions);
  start(): Promise<string>;   // returns the base URL (e.g. "http://127.0.0.1:58200")
  stop(): Promise<void>;
  get url(): string;          // throws "Server not started" until start() resolves
  clear(): void;
  injectError(...): void;     // test-only fault injection
  injectFault(...): void;     // test-only
  clearInjectedFaults(): void;
  // EVERYTHING else (handleRequest, handleCreate, handleAppend, handleRead, ...) is PRIVATE
}
```

**CORRECTION to the README:** the README claims `start(): Promise<void>` and
`readonly port` / `readonly baseUrl` getters. The real `.d.ts` and the live run
show `start(): Promise<string>` (resolves to the base URL) and a `get url()`
getter. There is **no** `port`/`baseUrl` property. Use the return value of
`start()` or `server.url`.

Internally (from `dist/index.js`):

```js
this.server = createServer((req, res) => { ... this.handleRequest(req, res) ... });
this.server.listen(this.options.port, this.options.host, () => { ... });
```

→ It is bound to its own port. **`handleRequest(req, res)` is a private method
that operates on Node `IncomingMessage` / `ServerResponse`.** There is no
exported `(Request) => Response` (Web Fetch) handler and no exported
`(req, res) => void` Node handler. **Nothing to mount inside `Bun.serve`'s
`fetch`.** This is the decisive fact for embed-vs-sidecar.

### Programmatic append (no HTTP) - `StreamStore` / `FileBackedStreamStore`

Both store classes ARE exported and expose a programmatic append. This is the
in-process write path if we ever wanted to embed-by-reimplementing-routing
(we won't - see decision). In-memory `StreamStore`:

```ts
interface AppendOptions {
  seq?: string;
  contentType?: string;
  producerId?: string;
  producerEpoch?: number;
  producerSeq?: number;
  close?: boolean;
}
interface AppendResult { message: StreamMessage | null; producerResult?: ProducerValidationResult; streamClosed?: boolean; }

declare class StreamStore {
  create(path: string, options?: { contentType?: string; ttlSeconds?: number; expiresAt?: string; initialData?: Uint8Array; closed?: boolean; /* fork opts */ }): Stream;
  has(path: string): boolean;
  append(path: string, data: Uint8Array, options?: AppendOptions): StreamMessage | AppendResult;
  appendWithProducer(path: string, data: Uint8Array, options: AppendOptions): Promise<AppendResult>;
  read(path: string, offset?: string): { messages: Array<StreamMessage>; upToDate: boolean };
  waitForMessages(path: string, offset: string, timeoutMs: number): Promise<{ messages: Array<StreamMessage>; timedOut: boolean; streamClosed?: boolean }>;
  getCurrentOffset(path: string): string | undefined;
  closeStream(path: string): { finalOffset: string; alreadyClosed: boolean } | null;
  // ...
}
```

`StreamMessage` shape:

```ts
interface StreamMessage {
  data: Uint8Array;
  offset: string;     // "<read-seq>_<byte-offset>"
  timestamp: number;
}
```

`FileBackedStreamStore` mirrors the same surface but most methods are `async`
(it fsyncs to disk + LMDB) and the constructor takes `{ dataDir, maxFileHandles? }`.
**Caveat:** the store classes are NOT wired to long-poll/SSE HTTP responses by
themselves - that logic lives inside the private `handleRequest`. So using the
store directly means we'd ALSO have to reimplement the read/SSE endpoints for
the browser. Not worth it.

---

## CLIENT API (`@durable-streams/client`)

Three surfaces: `stream()` (read-only fetch-like), `DurableStream` (read/write
handle), `IdempotentProducer` (exactly-once high-throughput writes).

### `stream()` - read / subscribe (catch-up + live + resume)

```ts
type Offset = string;                       // opaque; "-1" === start of stream
type LiveMode = boolean | `long-poll` | `sse`;

interface StreamOptions {
  url: string | URL;
  headers?: HeadersRecord;                  // string | (() => MaybePromise<string>)
  params?: ParamsRecord;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  backoffOptions?: BackoffOptions;
  offset?: Offset;                          // resume point; default "-1" (start)
  live?: LiveMode;                          // default true (auto: SSE for JSON, long-poll for binary)
  json?: boolean;
  onError?: StreamErrorHandler;
  sseResilience?: SSEResilienceOptions;     // auto-fallback SSE -> long-poll
  warnOnHttp?: boolean;                     // default true; warns on http:// in browser
}

declare function stream<TJson = unknown>(options: StreamOptions): Promise<StreamResponse<TJson>>;
```

`StreamResponse` (verbatim, the bits we use):

```ts
interface StreamResponse<TJson = unknown> {
  readonly url: string;
  readonly contentType?: string;
  readonly live: LiveMode;
  readonly startOffset: Offset;
  readonly offset: Offset;        // next offset to read from (advances AFTER delivery) -> persist for resume
  readonly cursor?: string;
  readonly upToDate: boolean;     // caught up to head
  readonly streamClosed: boolean; // EOF

  body(): Promise<Uint8Array>;
  json<T = TJson>(): Promise<Array<T>>;   // accumulate items until first upToDate
  text(): Promise<string>;

  bodyStream(): ReadableStreamAsyncIterable<Uint8Array>;
  jsonStream(): ReadableStreamAsyncIterable<TJson>;
  textStream(): ReadableStreamAsyncIterable<string>;

  subscribeJson<T = TJson>(subscriber: (batch: JsonBatch<T>) => void | Promise<void>): () => void;
  subscribeBytes(subscriber: (chunk: ByteChunk) => void | Promise<void>): () => void;
  subscribeText(subscriber: (chunk: TextChunk) => void | Promise<void>): () => void;

  cancel(reason?: unknown): void;
  readonly closed: Promise<void>;
}
```

### Catch-up vs live message shapes

The batch/chunk metadata (shared base `JsonBatchMeta`):

```ts
interface JsonBatchMeta {
  offset: Offset;        // last Stream-Next-Offset for this batch  -> save for resume
  upToDate: boolean;     // true once this batch reaches the head
  cursor?: string;       // CDN-collapsing cursor, if server sent one
  streamClosed: boolean; // true once EOF (final batch)
}
interface JsonBatch<T = unknown> extends JsonBatchMeta { items: ReadonlyArray<T>; }
interface ByteChunk        extends JsonBatchMeta { data: Uint8Array; }
interface TextChunk        extends JsonBatchMeta { text: string; }
```

- **Catch-up vs live is not two different message types** - it's the same
  `JsonBatch`/`ByteChunk`. The `upToDate` flag flips to `true` on the batch
  that reaches the head. With `live: false` the session stops at the first
  `upToDate`. With `live: true` it keeps the connection open (SSE/long-poll)
  and delivers subsequent batches as they arrive; the EOF batch carries
  `streamClosed: true`.
- **Resume/offset:** every batch carries `offset`. Persist the latest `offset`
  (or read `res.offset` on the response object). To resume after a disconnect
  or page reload, pass it back as `stream({ url, offset, live })`. The browser
  dashboard (Task 4) saves it in `localStorage` and reconnects from there.

### `DurableStream` - read/write handle (the producer)

```ts
interface CreateOptions extends StreamHandleOptions {  // StreamHandleOptions has url, headers, params, fetch, signal, contentType, onError, batching?, warnOnHttp?
  ttlSeconds?: number;
  expiresAt?: string;        // RFC3339
  body?: BodyInit | Uint8Array | string;
  batching?: boolean;        // default true
  closed?: boolean;          // create immediately-closed stream
}
interface AppendOptions {
  seq?: string;              // writer-coordination (Stream-Seq); 409 if < last
  contentType?: string;
  signal?: AbortSignal;
  producerId?: string;       // idempotent-write tuple
  producerEpoch?: number;
  producerSeq?: number;
  // close?: ...
}

declare class DurableStream {
  readonly url: string;
  contentType?: string;
  constructor(opts: DurableStreamOptions);

  static create(opts: CreateOptions): Promise<DurableStream>;     // create-only PUT; CONFLICT_EXISTS if present
  static connect(opts: DurableStreamOptions): Promise<DurableStream>; // validates via HEAD
  static head(opts: DurableStreamOptions): Promise<HeadResult>;
  static delete(opts: DurableStreamOptions): Promise<void>;

  head(opts?: { signal?: AbortSignal }): Promise<HeadResult>;
  create(opts?: Omit<CreateOptions, keyof StreamOptions>): Promise<this>;
  delete(opts?: { signal?: AbortSignal }): Promise<void>;
  close(opts?: CloseOptions): Promise<CloseResult>;               // EOF; CloseResult = { finalOffset: Offset }
  append(body: Uint8Array | string | Promise<Uint8Array | string>, opts?: AppendOptions): Promise<void>;
  appendStream(source: AsyncIterable<Uint8Array | string> /* or ReadableStream */, opts?: AppendOptions): Promise<void>;
  // writable(opts?): WritableStream<Uint8Array | string>;
  stream<TJson>(opts?: StreamOptions): Promise<StreamResponse<TJson>>;
}
```

For ax's `bus.publish(runId, event)`: create the per-run stream once
(`DurableStream.create({ url: <serverUrl>/ingest:<runId>, contentType: "application/json" })`),
then `handle.append(JSON.stringify(event))` per event. On run completion,
`handle.close()` to signal EOF so dashboards stop tailing.

> Batching note (from `.d.ts`): `append()` calls coalesce into one POST only if
> fired without awaiting each. If you `await` every call in a loop, no batching.
> For a steady trickle of progress events this is fine; for bursts, fire
> several `append()` without awaiting and await the last, or use
> `IdempotentProducer`.

### `IdempotentProducer` - exactly-once writes (optional, for robustness)

```ts
new IdempotentProducer(stream: DurableStream, producerId: string, opts?: IdempotentProducerOptions)
interface IdempotentProducerOptions {
  epoch?: number;        // default 0
  autoClaim?: boolean;   // on 403 retry epoch+1; default false
  maxBatchBytes?: number;// default 1MB
  lingerMs?: number;     // default 5
  maxInFlight?: number;  // default 5
  headers?: HeadersRecord;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  onError?: (error: Error) => void;  // append() is fire-and-forget; errors land here
}
// methods: append(body): void  |  flush(): Promise<void>  |  close(finalMessage?): Promise<CloseResult>  |  detach()  |  restart()
```

---

## On-the-wire protocol (the server is a plain HTTP handler)

The stream **path === stream key**. Methods (from the private `handleRequest`
switch in `dist/index.js`):

| Method | Path | Effect |
|---|---|---|
| `PUT`    | `/<stream-path>` | create stream (idempotent if same config) |
| `HEAD`   | `/<stream-path>` | metadata (current offset, content-type, closed) |
| `GET`    | `/<stream-path>?offset=&live=&cursor=` | read; long-poll or SSE for live tail |
| `POST`   | `/<stream-path>` | append data |
| `DELETE` | `/<stream-path>` | delete stream |
| `OPTIONS`| any | CORS preflight (204) |

Protocol headers/params (verbatim constants from the client `.d.ts`):

```ts
// response headers
STREAM_OFFSET_HEADER    = "Stream-Next-Offset"
STREAM_CURSOR_HEADER    = "Stream-Cursor"
STREAM_UP_TO_DATE_HEADER= "Stream-Up-To-Date"
STREAM_CLOSED_HEADER    = "Stream-Closed"
// request headers
STREAM_SEQ_HEADER       = "Stream-Seq"
STREAM_TTL_HEADER       = "Stream-TTL"
STREAM_EXPIRES_AT_HEADER= "Stream-Expires-At"
PRODUCER_ID_HEADER      = "Producer-Id"
PRODUCER_EPOCH_HEADER   = "Producer-Epoch"
PRODUCER_SEQ_HEADER     = "Producer-Seq"
PRODUCER_EXPECTED_SEQ_HEADER = "Producer-Expected-Seq"
PRODUCER_RECEIVED_SEQ_HEADER = "Producer-Received-Seq"
// query params
OFFSET_QUERY_PARAM = "offset"
LIVE_QUERY_PARAM   = "live"
CURSOR_QUERY_PARAM = "cursor"
// SSE event field names
SSE_OFFSET_FIELD = "streamNextOffset"
SSE_CURSOR_FIELD = "streamCursor"
SSE_CLOSED_FIELD = "streamClosed"
```

CORS: the server sets `access-control-allow-origin: *`,
`access-control-allow-methods: GET, POST, PUT, DELETE, HEAD, OPTIONS`, and
exposes the `Stream-*` / `Producer-*` headers. So a browser on a different
origin/port can read it directly - which matters for the sidecar choice.

Offset format observed: `"<read-seq>_<byte-offset>"`, e.g.
`0000000000000000_0000000000000083`. `"-1"` means start-of-stream.

This documents the fallback for **Risk #2** ("implement endpoints directly"):
if we ever drop the package, we owe exactly these 5 verbs + these headers.

---

## DECISION: (B) Sidecar

**Pick (B): spawn `@durable-streams/server` (`DurableStreamTestServer`) on a
second localhost port from within `cmdServe`.**

**One key fact that drove it:** `@durable-streams/server` exposes **no**
`(Request) => Response` or `(req, res)` handler - the only HTTP entry is
`DurableStreamTestServer`, which calls `http.createServer(...).listen(port)`
itself and keeps `handleRequest` private. There is nothing adaptable to mount
inside `Bun.serve`'s `fetch`, so embed-as-handler (Option A) is **not
supported** by this package version (`0.3.5`).

Justification (2-3 sentences): The store classes (`StreamStore` /
`FileBackedStreamStore`) are exported with a programmatic `append()`, so a
"reimplement the routing/SSE around the store inside Bun.serve" embed is
*technically* possible - but it means re-deriving the long-poll/SSE read
endpoints and offset framing ourselves, which defeats the point of using the
package. The sidecar keeps us on the maintained protocol implementation for
near-zero code, and because the server already sends permissive CORS, the
browser dashboard can subscribe to `http://127.0.0.1:<sidecarPort>/ingest:<runId>`
directly. We stay "just bun + surreal" operationally (one extra in-process
`DurableStreamTestServer` started/stopped by `cmdServe`, on a localhost port);
this is still a single OS process - `server.start()`/`server.stop()` run inside
the same Bun process as `ax serve`, not a separately-spawned binary.

### Concrete shape for downstream tasks

- **Bring-up (in `cmdServe`):**
  ```ts
  import { DurableStreamTestServer } from "@durable-streams/server"
  const streamServer = new DurableStreamTestServer({ host: "127.0.0.1", port: 0 /* or a fixed port */, dataDir: <optional persist dir> })
  const streamBaseUrl = await streamServer.start()   // -> "http://127.0.0.1:<port>"
  // on shutdown: await streamServer.stop()
  ```
- **Producer `bus.publish(runId, event)` (Task 3):**
  ```ts
  import { DurableStream } from "@durable-streams/client"
  // once per run:
  const handle = await DurableStream.create({ url: `${streamBaseUrl}/ingest:${runId}`, contentType: "application/json" })
  // per event:
  await handle.append(JSON.stringify(event))
  // on run finish:
  await handle.close()
  ```
- **`handle(request): Promise<Response|null>` note:** because we chose the
  sidecar, ax's own `Bun.serve` fetch handler does **not** proxy stream
  traffic. The browser client points straight at `streamBaseUrl`. If a single
  origin is later required (e.g. one port for everything), add a thin reverse
  proxy in ax's `fetch` that forwards `/streams/*` to `streamBaseUrl` via
  `fetch()` - but that's a follow-up, not required for the happy path.

### Residual concern

`@durable-streams/server` is described in its own README as a "reference / test
server… For production deployments, use the Caddy plugin or Electric Cloud."
For ax's localhost single-user use case that's fine, and the file-backed
(`dataDir`) mode gives durability across restarts. If we later need a hardened
standalone, the Caddy-based server release is the documented upgrade path
(same wire protocol, so the client code is unchanged).
