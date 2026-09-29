# Internals

How this plugin works, and why it is built the way it is. Everything here was measured or traced in the deployment it runs in; where a claim rests on one machine's behaviour, it says so.

## Contents

- [Layout](#layout)
- [What it patches, and why it has to](#what-it-patches-and-why-it-has-to)
- [Measuring without guessing](#measuring-without-guessing)
- [Provider attribution](#provider-attribution)
- [The HTTP/2 transport](#the-http2-transport)
- [The pre-transmission pool](#the-pre-transmission-pool)
- [Request body shapes](#request-body-shapes)
- [Signed bodies](#signed-bodies)
- [HTTP/3](#http3)
- [Why not a dynamic Cordis plugin?](#why-not-a-dynamic-cordis-plugin)

## Layout

| File | Role |
| --- | --- |
| `install.sh` | One-command installer: clones the package into the profile and registers it in `cordis.patch.yml`. |
| `lib/compress.js` | Compression decision core: policy compilation, endpoint index, attribution resolution, the encoding plan, header rewriting. No Cordis, globals, or zlib, so it is directly unit-testable. |
| `lib/timing.js` | Timing state machine: phase boundaries, throughput, the per-session ring buffer, and the summary the page renders. Pure over injected clocks. |
| `lib/index.js` | Host half: settings, `llm/stream` attribution, timing measurement and its authenticated `/api` routes, the `globalThis.fetch` patch and restore. |
| `lib/client.js` | Browser half: the settings card and the request-timing view. Plain CJS factory contract — no JSX, no ESM syntax. |
| `lib/prewarm.js` | Pre-transmission core: the shared-prefix scanner, the field reordering, and the body-shape checks. Pure, so it is unit-testable. |
| `lib/transport.js` | The HTTP/2 transport: resolves one undici module instance, pairs its `fetch` with its own `allowH2` Agent, decides per request, and condemns an origin that failed. Optional by construction — with no undici resolvable, h2 is simply off. |
| `lib/ledger.js` | The durable per-session store, built on the deployment's storage domain. |
| `lib/version.js` | Three-part version parsing and comparison, which the update button reads. |
| `scripts/probe-encodings.mjs` | Asks an endpoint which request encodings it decodes, before there is traffic to learn from. |
| `scripts/migrate-legacy-settings.mjs` | Moves a 1.7.x `settings.yaml` section into the loader row this version reads. See [UPGRADING.md](./UPGRADING.md). |

## What it patches, and why it has to

Both shipped adapters (`dsh-llm-deepseek`, `dsh-llm-pi-ai`) call the global `fetch` directly, and the adapter seam exposes no header hook. So this plugin owns that seam for the lifetime of its fiber — it replaces `globalThis.fetch`, and restores the original when the plugin is stopped or removed. Everything it does happens inside that replacement.

## Measuring without guessing

The timing phases come from **undici's own diagnostics**, consumed through `node:diagnostics_channel`:

| Phase | Channel |
| --- | --- |
| `send` ends | `undici:request:bodySent` — the moment the transport finished writing the body |
| `server` | `undici:request:headers` |
| response bytes | `undici:request:bodyChunkReceived`, which reports **wire** bytes |

**Measuring never modifies the request.** The timing view alone leaves the body with its `content-length`. Compression and pre-transmission do rewrite the request, deliberately and visibly in the panel — the first compresses the body, the second sends it in two parts, which is why a pre-transmitted request carries a chunked body and its row says so.

**The hard part is that those channels are socket-scoped.** They are process-wide, but the response-side ones run inside the async context of whichever request first opened the socket. On a pooled keep-alive connection, reading the ambient context attributes `headers` to an older, already-finished request — which is exactly why a naive implementation reports the server phase for the first request on a connection and `null` for every one after it.

The fix is to pair each measurement with the undici **request object** at `undici:request:create`, which still runs in the caller's context, and to look every later diagnostic up by that identity. `test/host.test.mjs` asserts this on four sequential requests over one connection and fails if the pairing is reverted.

The same socket-scoping mistake is made twice more in this codebase's history, both found only by looking at real data rather than at a green test suite:

- undici announces `h2` on its connection diagnostic **before** a cleartext upgrade is proven, so an attempt the far end refuses also announces `h2` and then fails. The plugin holds the negotiated version until the send has actually succeeded.
- undici reports a connection **once per socket**, not once per request, so only the first request on a connection learned its protocol. The transport now remembers the protocol per origin.

## Provider attribution

A request URL is all the `fetch` layer sees, and when several provider routes share one endpoint — as they do when e.g. `llm-deepseek` and `llm-pi-ai.providers.sg` both point at the same gateway — the URL alone cannot tell them apart. Matching on it would make a per-provider switch behave per-endpoint.

So the plugin hooks the `llm/stream` waterfall and binds the streaming call's provider into an `AsyncLocalStorage` scope. Each iterator resumption runs inside that scope, so the identity survives the adapter's internal `await`s (image serialization, file uploads) and concurrent streams cannot clobber each other. This is why the `sendRequest` call site in `lib/index.js` is wrapped per-iteration rather than around the whole stream.

Endpoint matching is only a fallback for requests with no attributed provider, where the longest matching endpoint wins and the policies of the routes on it are OR-ed.

## The HTTP/2 transport

**Why it needs its own code.** Node's `globalThis.fetch` **speaks HTTP/1.1 only**: its dispatcher is the built-in undici's own `Agent`, undici negotiates h2 only when `allowH2` is *explicitly* passed, the built-in Agent does not pass it — and the built-in Agent class is not reachable from application code. `process.getBuiltinModule` does not resolve node's internal undici, and that specifier is not a public builtin. So the built-in transport has no knob to turn; measured, it reports `h1` even against a server that offers h2.

What works is a **consistent pair**: dsh's own `undici` package, driving its own `fetch` with its own `Agent({ allowH2: true })`. The two undici instances must never be crossed — handing an 8.x `Agent` to the built-in 7.x `fetch` fails at dispatch time with `invalid onRequestStart method` — which is the single rule `lib/transport.js` exists to enforce: **both halves from one module instance, or h2 stays off.**

**Finding undici is its own problem.** The transport resolves it by asking Node, not by guessing a path: `require.resolve("undici")` from the plugin, then through dsh's own resolution, then through `DSH_PROFILE_DIR`. A plugin installed by **link** resolves to its checkout, where walking up from the file's own path never reaches the profile's hoisted tree — the first version of this did exactly that and left h2 **silently off in a real deployment** while every test passed.

**Degradation is the protocol's own, not a retry state machine.** h2 is reached through ALPN, so an endpoint that does not offer it continues on HTTP/1.1 through the same Agent — no error, and no signal to detect. All `lib/transport.js` handles is what ALPN cannot cover: a transport that fails outright, or an `http://` endpoint needing cleartext h2c (off by default).

A single failure is retried once on a fresh connection before the origin is condemned, because one failure is more often that connection's than that endpoint's — and condemning an origin is permanent. The retry **stands down for a body that cannot be sent twice**, which is the shape every held member has: replaying a consumed stream throws `Response body object should not be disturbed or locked`, a second failure that would condemn the endpoint for a reason unrelated to it.

**The cleartext upgrade announces two connections on one origin and port**, in order: the http/1.1 socket it starts as, then the h2 session it became. Taking the last announcement recorded `h1` for requests that really did travel over h2, so `h2` wins whenever it is mentioned at all.

**A held member is listened for at the wrong time if you unsubscribe on return.** Its caller deliberately does not await the response — a member is *meant* to stay open — so the connection it opened is announced after the call would have returned. The listener lives until the send settles.

## The pre-transmission pool

Each conversation holds `prewarmPoolSize` members (default `3`). Members are opened at staggered moments and **advanced as content becomes known**, so the one that gets consumed has already been in flight for several steps rather than one.

- **Open** — a model call goes out and its history is therefore known; every member is advanced to it and the pool is refilled. The bytes are slices of the request that was just captured, never reconstructed.
- **Reorder** — see below.
- **Consume** — the next request claims the member whose bytes it continues **furthest** and whose headers still match. Members sit at different depths, so the deepest match leaves the least to write. Survivors are advanced and the pool refilled.
- **Keep** — a step that ends the turn (`stop`, `max-tokens`, an error, an interruption) rather than continuing with `tool-calls` leaves the pool exactly where it is. A finished conversation is usually a pause, and the next question repeats the same history, so the members would have been reused verbatim. The hold timer owns them instead, and it measures **idleness**: it restarts on every advance, so a member expires only after `prewarmHoldMs` with nothing happening. Nothing reconnects while a conversation sits idle, because members are opened by a captured request and by nothing else.

**The reordering.** A prefix can only be the beginning of a body. DSH's adapters put `messages` second and everything fixed after it — the tool schemas above all, then the stream flag, the tool choice and the rest — so none of that could ever be pre-sent and was uploaded again on every request. Since a JSON object is unordered, the plugin moves `messages` to the end, one key, leaving every other field in place, and the whole fixed part then travels inside the prefix. The live increment falls from about 50 KB of text to just the new turn — under a kilobyte on the wire.

It is deliberately minimal and refused whenever it cannot be proven byte-safe: the body must be exactly `JSON.stringify` output, so re-serializing leaves every field's own bytes alone. A relay that matches on the body's shape answers `400`/`422`; that request is then sent again in the adapter's own order, the endpoint is remembered, and pools built in the rejected order are released.

**The pool belongs to one agent**, not to a session tree. A subagent is a separate agent with its own session id, and the loop stamps each request with its own agent's session, so a child's pool never mixes with its parent's — even when the two histories are byte-identical, which is the case a shared pool would silently corrupt.

The one thing shared across agents is the decision to stop pre-transmitting to an **endpoint**, because whether it accepts a chunked body is a property of the endpoint rather than of the conversation asking. It takes a shape rejection (`411`/`415`/`501`), which retrying cannot fix, or three consecutive failures — so one transient 5xx or rate limit does not switch the feature off everywhere.

**Held requests are always closed by themselves.** A consumed member is finished by writing its increment and closing the body, after which undici returns the socket to its keep-alive pool rather than closing it. Each later request on that socket is a **brand-new HTTP request**: the far end runs its per-request work — routing, quota, token counting — exactly as it would on a fresh socket, and only the TCP and TLS handshakes are skipped. An abandoned member is aborted by whichever path abandoned it: the hold timer, a mismatch, a refused body, the pool being released, or the plugin unloading. Nothing lingers past `prewarmHoldMs` of idleness.

**Compression and pre-transmission compose.** The split keeps **one** codec stream open across every part, so the parts decompress as a single body and the compression is kept rather than traded away.

## Request body shapes

The plugin reads the request body's **shape**, not a protocol name. Pre-transmission and the field reordering need a top-level array that a conversation is appended to, and both chat-completions (`messages`) and Anthropic-shaped (`messages`) bodies have one, as do Responses-shaped bodies (`input`). A body whose `input` is a plain string has no such array and gets **no** pre-transmission rather than a wrong one — the panel reports it as `不适用` instead of an empty pool.

Request-body compression and the timing breakdown are transport-level and apply to every protocol.

## Signed bodies

A request carrying `x-amz-content-sha256` (AWS-style signing) never has its body compressed: the signature covers the body's bytes, so compressing it would break the signature — and the resulting authorization failure is **not** a shape rejection, so the fallback that recovers from a refused encoding would never trigger. Bedrock-style transports are out of scope for the same reason the reference implementation lists them as such.

## HTTP/3

**Not reachable on this stack**, so the plugin does not offer it. undici contains **no** HTTP/3 or QUIC code, and Node 24.12 ships neither `nghttp3` nor `ngtcp2` (`node:quic` exists as a builtin with no QUIC stack behind it). The only route would be a separate HTTP/3 client library with a hand-built transport, which would **lose every undici diagnostic** — and the timing breakdown and the pre-transmission pool both rest on those. For a gateway that advertises only h2, that trade buys nothing.

HTTP/2 is offered because it is a transport swap on the same diagnostics, not a replacement for them.

## Why not a dynamic Cordis plugin?

Dynamic plugins run in a `node:vm` sandbox where `fetch` and `require` are trapped to throw, `process` is `undefined`, and there is no zlib, `Buffer`, or `CompressionStream`. Such a plugin can neither compress a body nor reach the realm the adapters fetch from, so this has to be a file-loaded Cordis plugin.
