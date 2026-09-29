# Troubleshooting

Every provider starts **off**, so the first thing to try is always the same: turn the switch off in **Settings → 模型请求加速**. The change is live — no restart needed — and it restores exactly the behaviour you had before installing this.

## Contents

- [Model requests fail or answer strangely](#model-requests-fail-or-answer-strangely)
- [Compression](#compression)
- [Pre-transmission](#pre-transmission)
- [HTTP/2](#http2)
- [The timing view](#the-timing-view)
- [The settings page](#the-settings-page)
- [Reading the endpoint report](#reading-the-endpoint-report)
- [What this plugin cannot do](#what-this-plugin-cannot-do)

## Model requests fail or answer strangely

Turn the provider's switch off in the settings page and try again.

- **It works with the switch off.** The cause is compression or pre-transmission. See below.
- **It still fails.** The plugin is not the cause — unless the log shows a line for that request. Check the Host output for `model-request-accelerator:` lines.

If the plugin's own rewrite throws, it falls back to sending the request uncompressed, so a bug in this plugin cannot break model requests. If you suspect it anyway, uninstalling is immediate and reversible — see the README.

## Compression

**Symptom: a request failed after enabling compression.**

Your gateway may not decode that encoding. Two things happen automatically: a brotli body answered with `411`, `415` or `501` is retried as gzip, and an endpoint that refuses an encoding repeatedly has compression switched off for it. So the worst case is **one** extra request per endpoint, once.

To check before relying on it, or to see what happened:

```bash
node scripts/probe-encodings.mjs https://your-gateway.example/v1
```

It sends a one-token request rather than a real conversation. If you would rather not have it try brotli at all, set **Algorithm** to `gzip` — gzip is near-universal, and a gateway that rejects it is rare.

**Symptom: the log shows `content-length` bodies but nothing was compressed.**

Compression is skipped below `minBytes` (default `1024`), and whenever compressing would not actually make the body smaller. A small JSON body often is not worth compressing, and sending it uncompressed is the correct answer rather than a failure.

**Where to look:** the Host logs one line per compressed request.

```
model-request-accelerator: sg request compressed 3813841 -> 1461179 bytes
```

`endpoint-matched` appears instead of a provider name when a request could not be attributed to a provider.

## Pre-transmission

**Symptom: no 预热 chip on a timing row.**

Two possible causes:

1. **The request could not be attributed to a provider.** The log says `endpoint-matched` instead of a provider name. This happens when a request reaches `fetch` outside a streaming model call.
2. **The endpoint refused a chunked body**, so pre-transmission was switched off for it. The settings card says so — see [Reading the endpoint report](#reading-the-endpoint-report).

A held request must carry a **chunked** body, because its length cannot be known before the increment is. An endpoint that will not accept one cannot support this feature, and the plugin stops trying rather than degrading every request.

**Symptom: pre-transmission worked, then stopped.**

Check the 预热 chip's tooltip on a row that did use it. If the pool keeps being rebuilt, the endpoint is likely rejecting the reordered body — the plugin then reverts to the adapter's own field order for that endpoint and remembers it. That is a correctness fallback, not a failure: requests still work, they are just not pre-transmitted there.

**Symptom: held requests are visible as open connections.**

That is what the feature does. A conversation keeps `prewarmPoolSize` requests held (default `3`), and they expire after `prewarmHoldMs` of **idleness** (default `120000`, two minutes) — the timer restarts every time a member is advanced. Nothing reconnects while a conversation sits idle, because members are only opened by a captured request. Reducing `prewarmPoolSize` to `1` is the smallest useful pool.

## HTTP/2

**Symptom: a timing row has no `h2` chip.**

Most likely your gateway does not offer HTTP/2 — in which case requests continue over HTTP/1.1 and **nothing is wrong**. h2 is reached through ALPN, so an endpoint that does not offer it simply keeps working on HTTP/1.1.

The chip appears **only when a response really came back over h2**. "Asked for h2" and "used h2" are not the same thing, and the plugin deliberately does not treat them as the same.

**Symptom: the settings card says an endpoint was abandoned.**

The plugin tries h2, and if the transport fails outright it gives that **origin** up for the life of the plugin — one extra round trip, ever, rather than one per request. Requests continue over HTTP/1.1. Restarting `dsh web` clears the decision and lets it try again.

**Symptom: an `http://` endpoint does not use h2.**

Cleartext h2c is off by default. `allowInsecureH2c: true` enables it, over a connection with **no certificate** — only for a link you trust.

## The timing view

**The view is missing.** It appears only while **Show the Request timing view** is on. Turn it on in the settings page; the tab appears immediately, without a page reload.

**The panel is empty.** It lists requests from the current session. If the session is new, make a model call. If you just cleared the ledger, the history is gone by design — clearing is permanent, and it drops both the stored documents and what the running process holds.

**A row has `–` for the response body.** No chunk was attributed to that request at all. That is a wiring fault worth seeing, rather than an empty reply — please report it.

**A row has `不适用` where a pre-transmission chip would be.** The request body has no top-level array to append a conversation to, so pre-transmission does not apply to it. See [INTERNALS.md](./INTERNALS.md#request-body-shapes).

## The settings page

**The page is missing, or its switches are all off and greyed out.**

Reload the browser tab first — the card is part of the page's module graph, so a tab that was open during installation will not have it. If it is still missing, the plugin did not load: check the Host output for an error naming `model-request-accelerator`.

**Saving says `Configuration for "model-request-accelerator" is overridden by a home patch or command-line overlay`.**

This means the plugin's settings are not where this version reads them — a 1.7.x install upgraded without the migration. See **[UPGRADING.md](./UPGRADING.md)**.

**Saving says `Config field "..." is not volatile`.**

You are running a 2.0.0 or 2.0.1 Host half with a newer page. Restart `dsh web` after updating, or update to 2.0.2 or later.

## Reading the endpoint report

The settings card reports, per endpoint, what real traffic has established:

- whether a compressed body was ever **refused**, and so whether gzip has taken over from brotli;
- whether **pre-transmission was switched off** because the endpoint would not take a chunked body;
- how many compression attempts have **failed in a row**.

It is a record of observations, **not a probe** — nothing is sent to produce it — and it stays silent until there is something to report. An endpoint that has behaved simply says nothing, which is the normal and healthy state. `scripts/probe-encodings.mjs` is the way to ask the question before any traffic exists.

## What this plugin cannot do

Being clear about the edges saves time later:

- **It cannot compress a signed body.** A request carrying `x-amz-content-sha256` (AWS-style signing) is left alone: the signature covers the body's bytes, so compressing it would break the signature — and the resulting authorization failure is not a shape rejection, so the fallback that recovers from a refused encoding would never trigger. Bedrock-style transports are out of scope for this reason.
- **It cannot see a transport that does not use `fetch`.** WebSocket, or an SDK with its own HTTP stack, never passes through it.
- **It cannot offer HTTP/3.** Not reachable on this stack — see [INTERNALS.md](./INTERNALS.md#http3).
- **It cannot make the model faster.** It moves bytes off the critical path and shrinks them. It does not change what the model does with them, and it can be slower than the alternative on a fast link with a small context.
- **It cannot compress a response.** Responses are already compressed by the runtime; this plugin's compression is for the request only.
