# Configuration

Every setting lives on one page: **Settings → 模型请求加速**. This document explains what each one does, in the order worth reading them.

**Every provider starts off.** Turn one on, confirm it works for a day, then try the next. Compression is the safe one to start with; pre-transmission is the one that asks something of your gateway.

## Contents

- [The two plugin-wide switches](#the-two-plugin-wide-switches)
- [Per-provider settings](#per-provider-settings)
- [Compression](#compression)
- [Pre-transmission](#pre-transmission)
- [HTTP/2](#http2)
- [Timing](#timing)
- [Editing the file directly](#editing-the-file-directly)

## The two plugin-wide switches

| Setting | Key | Default | Notes |
| --- | --- | --- | --- |
| Timing records | — | — | How much the ledger holds, with a **清空** button. Clearing drops both the stored documents (including sessions this process never loaded) and what the running process holds. It cannot be undone, and the row says so. |
| Show the Request timing view | `timing` | `true` | Turning it off also stops the Host recording timings, so a deployment that does not want the view pays nothing for it. The view tab appears and disappears immediately — no page reload. |

## Per-provider settings

These are the columns of the page's table. Routes that share one endpoint are **grouped but configured independently**: each model call is attributed to the provider that issued it, and that provider's own switches decide. The endpoint is only consulted when a request cannot be attributed at all.

| Column | Key | Default | What it does |
| --- | --- | --- | --- |
| Toggle | `providers.<name>.enabled` | `false` | Compress this provider's model requests. |
| Algorithm | `providers.<name>.encoding` | inherits `encoding` | `brotli` or `gzip`. |
| HTTP/2 | `providers.<name>.http2` | on when the route pre-transmits | Offer HTTP/2 to this provider. See [HTTP/2](#http2). |
| Pre-transmission | `providers.<name>.prewarm` | `false` | Put this conversation's shared history on the wire early. See [Pre-transmission](#pre-transmission). |
| Minimum body size | `providers.<name>.minBytes` | `1024` | Not in the page; set it in the row's `config`. Requests below it are sent as-is, and compression is skipped whenever it would not actually make the body smaller. |

## Compression

**What it does:** compresses the **request** body and adds `content-encoding: br` (or `gzip`). A response is a different matter — Node's `fetch` already negotiates and decompresses those, and this plugin does nothing about them.

**Which algorithm.** `brotli` is the default, at **quality 9**. Brotli's own default is quality 11, which is deliberately not used: it costs about a second of *synchronous* CPU per megabyte, blocking the event loop, for only a few percent more. Quality 9 measures roughly 5–15% smaller than gzip for a comparable amount of time.

**There is no negotiation for a request body**, so the plugin learns by trying. If an endpoint answers a shape rejection — `411`, `415` or `501` — to a brotli body, the request is retried as gzip. The adapter never sees a failure it would not have seen uncompressed, and the endpoint is remembered, so brotli is attempted there exactly once. Choose `gzip` to skip the attempt entirely.

To ask before any traffic exists:

```bash
node scripts/probe-encodings.mjs https://your-gateway.example/v1
```

It sends a one-token request rather than a real conversation.

**What it measured:** a 3.8 MB body became 1.46 MB (38%). Compression is the least demanding thing this plugin does — it needs only that the far end can decode the encoding.

## Pre-transmission

**What it does:** keeps a pool of **held requests** per conversation and puts the shared history on the wire before the request that needs it exists. The step that needs it then appends only its increment.

**Why it helps.** A `/chat/completions` body is one JSON document, and no relay begins inference before it is complete — so this does not start the model sooner. What it does is finish the relay's *other* per-request work sooner. Token counting, quota pre-checks, body logging and WAF scanning are all proportional to the bytes received, and that work can dominate the wait once a context reaches hundreds of KB. A request whose history is already there when the increment is appended finishes that work sooner.

**What it requires.** An endpoint that accepts a **chunked** request body, because a held member's length cannot be known before the increment is. If yours does not, pre-transmission switches off for that endpoint — by itself — and a shape rejection (`411`/`415`/`501`) is resent as an ordinary request.

**How the pool behaves.**

- Each conversation holds `prewarmPoolSize` members (default `3`), opened at staggered moments and **advanced as content becomes known**, so the member that gets consumed has been in flight for several steps rather than one.
- A step claims the member whose bytes it continues **furthest** and whose headers still match. The deepest match leaves the least to write. Survivors are advanced and the pool refilled.
- A step that **ends the turn** (`stop`, `max-tokens`, an error, an interruption) rather than continuing with `tool-calls` leaves the pool exactly where it is — a finished turn is usually a pause, and the next question repeats the same history.
- `prewarmHoldMs` (default `120000`) measures **idleness**, and restarts on every advance. A member expires only after that long with nothing happening.
- The pool belongs to one **agent**, not to a session tree. A subagent has its own session id and therefore its own pool, so a child's pool never mixes with its parent's.
- The one thing shared between agents is the decision to stop pre-transmitting to an **endpoint**, because whether it accepts a chunked body is a property of the endpoint rather than of the conversation asking.
- Held requests are always closed properly: a consumed member has its increment written and its body closed, after which undici returns the socket to its keep-alive pool. An abandoned member is aborted by whatever abandoned it — the hold timer, a mismatch, a refused body, the pool being released, or the plugin unloading.

**Reading the result.** A pre-transmitted row carries a **预热** chip. Hover it for the pre-sent bytes, the increment, and how long the member was held — that last number is the lead time actually won, and it is the honest way to judge whether a larger pool is worth anything on your link.

A held member carries a **chunked** body, which is what the panel reports when it says so.

**Compression and pre-transmission compose.** The split keeps **one** codec stream open across every part, so the parts decompress as a single body and the compression is kept rather than traded away.

**The reordering, briefly.** A prefix can only be the start of a body, so anything the plugin wants to pre-send has to come early. DSH's adapters put `messages` second, with the tool schemas and other fixed fields after it — so none of that could ever be pre-sent, and it was uploaded again on every request. Since a JSON object is unordered, the plugin moves `messages` to the end, which lets the whole fixed part travel inside the prefix. It is refused whenever it cannot be proven byte-safe: the body must be exactly `JSON.stringify` output, so re-serializing leaves every field's own bytes alone. A relay that matches on the body's shape answers `400`/`422`; that request is then sent again in the adapter's own order and the endpoint is remembered.

## HTTP/2

**Set the expectation first: this is not a switch that makes requests several times faster.** In the measurement above, a 2.37 MB request spent **1.1 ms** in the send phase and **3391 ms** waiting on the server. The upload stopped being the bottleneck the moment compression and pre-transmission went in, and no protocol buys back the provider's thinking time.

What it is worth is two things:

1. **HPACK header compression.** Pre-transmission re-sends the *same* multi-kilobyte headers every step; HTTP/2 sends only the delta. Same idea as pre-transmission, applied to headers instead of the body.
2. **Multiplexing.** The held pool shares one connection instead of contending for several, and no handshake is repeated.

**If your gateway does not speak it, nothing breaks.** h2 is reached through ALPN, so an endpoint that does not offer it simply continues on HTTP/1.1 through the same connection pool — no error, and nothing to configure.

**The `h2` chip tells the truth.** A timing row carries it **only when the response really came back over HTTP/2**. An endpoint that genuinely negotiates h2 says nothing in the settings card; one the plugin gave up on is named there.

**Cleartext h2c is off by default.** `allowInsecureH2c: true` makes `http://` endpoints use HTTP/2 too, over a connection with **no certificate**. Enable it only when you trust that link.

**HTTP/3 is not offered**, because it is not reachable on this stack. See [INTERNALS.md](./INTERNALS.md#http3).

## Timing

`timing` (default `true`) is the plugin-wide switch for recording; the page renders the view only while it is on.

The view splits every model call into phases:

```
stream begins ──▶ fetch() ──────▶ body sent ──────▶ first token ──────▶ end
      │             │                │                  │              │
      │          prepare          send            TTFT    │        generation
      │                            └──── server ─────┘   │              │
      └────────────────────────── total ───────────────────────────────┘
```

| Column | Meaning |
| --- | --- |
| 时间 | When the request was issued, to the second. |
| 提供方 / 模型 | Provider route, model, purpose (compaction or session title), a `br`/`gzip` chip naming the algorithm actually used, and a running or failed badge. |
| 发送 | The request being issued → **the body fully sent**. |
| 服务端 | Body sent → response headers received. |
| 首token | Wait until the first token — from the request being issued, or for a pre-transmitted row from the member being claimed. The server's own think time is in the row tooltip. |
| 生成 | First token → stream end. |
| tok/s | Output tokens ÷ the generation window. |
| 缓存 | Share of the prompt the provider served from its prefix cache. |
| 请求体 | `before → after` when the body was compressed, otherwise the single serialized size. |
| 响应体 | Bytes received **on the wire**, plus the response's `content-encoding` when it declares one. A `–` means no chunk was attributed at all, which is a wiring fault rather than an empty reply. |
| 总计 | Fetch call → stream end. |

Hover a header for what it means, or a row for what does not fit: the preparation time, token counts, and response size with its encoding.

**A note on prefix caching.** The 缓存 column is the provider's own accounting. Prefix reuse is a **server-side** mechanism — providers hash the prompt prefix and reuse the computed KV cache — so the client's only lever is keeping the prefix byte-stable across turns, which DSH already does. It is a different thing from pre-transmission: reuse avoids recomputing the prompt, pre-transmission gets the bytes there sooner. Neither substitutes for the other.

Measurements are held in memory (last 100 requests per session, last 40 sessions) and **persisted per session** in the deployment's storage backend (`~/.dsh/storages`), so reopening a session — or restarting DSH — shows its history rather than an empty panel. A profile with no storage backend keeps them in memory only.

## Editing the file directly

Settings are the loader row's `config`. The page writes it for you, and the Host validates a write against the plugin's schema and refuses a bad one — so the page is the safer route. It is also where the plugin looks first, so a hand-edit can be overwritten by the page.

```yaml
- insert:
    - id: model-request-accelerator
      name: './plugins/model-request-accelerator/lib/index.js'
      config:
        providers:
          sg:
            enabled: true
            prewarm: true
        encoding: auto
        prewarmHoldMs: 120000
        prewarmPoolSize: 3
        http2: true
        allowInsecureH2c: false
        timing: true
```

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `providers.<name>.enabled` | boolean | `false` | Compress this provider's requests. |
| `providers.<name>.minBytes` | number | `1024` | Skip compression below this size. |
| `providers.<name>.prewarm` | boolean | `false` | Pre-transmit for this provider. |
| `providers.<name>.http2` | boolean | on when `prewarm` | Offer HTTP/2 for this provider. |
| `providers.<name>.encoding` | `auto` \| `gzip` | inherits `encoding` | Algorithm for this provider. |
| `encoding` | `auto` \| `gzip` | `auto` | Section default. `auto` prefers brotli and falls back to gzip. |
| `prewarmHoldMs` | number ≥ 1000 | `120000` | How long a held request may sit idle before it is abandoned. |
| `prewarmPoolSize` | number ≥ 1 | `3` | How many held requests one conversation keeps. |
| `http2` | boolean | `true` | Plugin-wide kill switch for HTTP/2. |
| `allowInsecureH2c` | boolean | `false` | Also use HTTP/2 for `http://` endpoints, with no certificate. |
| `timing` | boolean | `true` | Record request timings and offer the timing view. |

A field left out takes its default. A provider's `http2` defaults to **on when that provider pre-transmits** and off otherwise, because pre-transmission is where h2 pays.
