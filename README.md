# dsh-plugin-model-request-accelerator

**模型请求加速** — make DeepSeek Harness model requests smaller and get them moving sooner, and show where each one spends its time.

Three things, each switchable per provider:

| | What it does | Default |
| --- | --- | --- |
| **Compression** | Compresses the request body (brotli, falling back to gzip) before it is uploaded | Off |
| **Pre-transmission** | Puts the shared conversation history on the wire before the request that needs it, so a step uploads only its increment | Off |
| **Request timing** | A view beside the Trajectory that splits every model call into its phases | On |

> 中文文档：[README.zh.md](./README.zh.md)

## Contents

- [What it does](#what-it-does)
- [Requirements](#requirements)
- [Install](#install)
- [Configure](#configure)
- [Confirm it works](#confirm-it-works)
- [If something goes wrong](#if-something-goes-wrong)
- [Updating](#updating)
- [Uninstall](#uninstall)
- [More](#more)

## What it does

**Compression targets the upload, not the reply.** Responses are already compressed — Node's `fetch` sends `accept-encoding: gzip, deflate` and decompresses automatically, and this plugin does nothing about that. What is *not* compressed is the request: a JSON body carrying a long context and base64 images goes up as-is. That is the half this plugin shrinks.

**Pre-transmission targets the round trip.** A multi-turn request re-sends its entire history every step. A long history does not reach the far end instantly, and a relay's per-request work — token counting, quota checks, body logging, WAF scanning — grows with the bytes it has received. Sending the history early means the step that needs it appends a few hundred bytes instead of megabytes.

**Timing shows you what happened.** Every model call is split into preparation, send, server, first-token and generation phases, with tokens per second and the provider's prefix-cache hit rate, so you can see whether any of the above is helping.

Measured on a real session: a **3.8 MB** request body became **1.46 MB**, with a few hundred bytes left for the step itself to write.

**Nothing is enabled for you.** Every provider starts off. Turn one on, confirm it works, then try the next.

## Requirements

- DeepSeek Harness, with a profile that has a browser UI (the `web` profile ships one).
- Node.js >= 20. The one bundled with DSH is fine.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/HolynnChen/dsh-plugin-model-request-accelerator/main/install.sh | sh
```

That clones the plugin into `$DSH_HOME/profiles/web/plugins/model-request-accelerator` and registers it in the profile's `cordis.patch.yml`. It is safe to re-run — it fast-forwards an existing checkout, leaves an existing entry alone, and **never overwrites settings you have changed**. For another profile or DSH home:

```bash
DSH_HOME=~/.dsh DSH_PROFILE=web sh install.sh
```

Then **reload the browser tab** (the settings page is part of the page's module graph, so an open tab will not have it) and open **Settings → 模型请求加速**.

<details>
<summary>Manual install</summary>

**1. Clone it into your profile**

```bash
git clone https://github.com/HolynnChen/dsh-plugin-model-request-accelerator.git \
  "${DSH_HOME:-$HOME/.dsh}/profiles/web/plugins/model-request-accelerator"
```

No dependency install is usually needed: Node walks up from the plugin directory into the profile's own `node_modules`, where DSH's packages already live. If your layout differs, run `npm install --omit=dev` in the cloned directory.

**2. Register it**

Append to `${DSH_HOME:-$HOME/.dsh}/profiles/web/cordis.patch.yml`, which is a top-level YAML array:

```yaml
- insert:
    - id: model-request-accelerator
      name: './plugins/model-request-accelerator/lib/index.js'
```

The relative `name` resolves against the profile directory, so it keeps working across machines. An absolute path works too.

**3. Reload the page.**

</details>

## Configure

Everything is on one page: **Settings → 模型请求加速**, beside General, Models and Plugins.

**Two plugin-wide switches**

- **Timing records** — how much the ledger holds, with a **清空** button. Clearing is permanent, and it also drops what the running process holds.
- **Show the Request timing view** — off means the Host stops recording timings too, so a deployment that does not want the view pays nothing for it. Takes effect immediately, no reload.

**One row per provider route**

- **Toggle** — compress this provider's requests.
- **Algorithm** — `brotli` (default) or `gzip`.
- **HTTP/2** — on by default for a route that pre-transmits, off until asked for otherwise.
- **Pre-transmission** — off by default.

Routes that share one endpoint are configured **independently**, because every model call is attributed to the provider that issued it. The endpoint is only consulted when a request cannot be attributed at all.

If you prefer a file, these are the same settings — the loader row's `config`, which the page edits for you. The page is the safer way to change them, since the Host validates writes against the plugin's schema and refuses a bad one:

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

Every key, and what each does, is in **[docs/CONFIGURATION.md](./docs/CONFIGURATION.md)** — including the two things worth reading before you turn compression on: what compression can and cannot help, and what pre-transmission requires of your gateway.

### The short version

- **Compression** needs the far end to decode it. gzip is near-universal; brotli is not. If an endpoint refuses a brotli body the plugin retries as gzip, remembers, and never tries brotli there again — so the worst case is one wasted request, once. You can ask first instead:

  ```bash
  node scripts/probe-encodings.mjs https://your-gateway.example/v1
  ```

- **Pre-transmission** needs an endpoint that accepts a **chunked** request body. If yours does not, it switches off for that endpoint by itself.
- **HTTP/2** is not a speed switch. The upload is not the bottleneck once compression is on; what h2 buys is header compression for the repeated requests and one connection for the held pool. If your gateway does not speak it, requests continue on HTTP/1.1 — nothing breaks.

## Confirm it works

The Host logs one line per compressed request:

```
model-request-accelerator: sg request compressed 3813841 -> 1461179 bytes
```

Open the **Request timing** view beside the Trajectory to watch requests as they happen. A row shows the algorithm it used (`br`/`gzip`), whether it was pre-transmitted (**预热**), and how long the request was held before it was claimed — that last number is the lead time actually won.

## If something goes wrong

**Model requests fail, or answer strangely.** Turn the provider's switch off in the settings page. The change is live — no restart — and every provider starts off, so this is always reversible.

**A request failed after enabling compression.** Your gateway may not accept that encoding. The plugin retries once as gzip automatically; if gzip is refused too, compression is switched off for that endpoint. If an endpoint answers `411`/`415`/`501` to a compressed body, that is the shape rejection it handles. Check with `scripts/probe-encodings.mjs`, or set **Algorithm** to `gzip`.

**Pre-transmission is not being used** (no **预热** chip). Either the request could not be attributed to a provider, or the endpoint refused a chunked body and pre-transmission was switched off for it. The settings card reports the second case; `endpoint-matched` in the log means the first.

**HTTP/2 is not being used** (no `h2` chip). Most likely your gateway does not offer it — in which case requests continue over HTTP/1.1 and nothing is wrong. A `h2` chip appears **only when a response really came back over h2**, so its absence is not a failure. An endpoint the plugin gave up on is named in the settings card.

**The settings page is empty, or saving says it is "overridden".** That means the plugin's configuration is not where this version reads it. See **[docs/UPGRADING.md](./docs/UPGRADING.md)**.

**Something looks broken and you want out.** Delete the plugin's entry from `cordis.patch.yml` and reload the page. See [Uninstall](#uninstall).

## Updating

The settings card shows the version with a button. **Opening the card checks by itself**; **检查更新** asks again and compares against the repository's `main`. When the published version is newer the button becomes **更新到 X**, and it does a fast-forward pull of the plugin's own directory.

**After updating, restart `dsh web`.** The Host half is loaded at startup and is not picked up by the live reload; the browser half only needs a page reload.

Upgrading from **1.7.x** has its own migration, which the installer runs for you — see **[docs/UPGRADING.md](./docs/UPGRADING.md)**.

## Uninstall

Delete the `model-request-accelerator` entry from `cordis.patch.yml`, and the cloned directory if you want it gone. The change is live; reload the page and the card is gone.

## More

- **[docs/CONFIGURATION.md](./docs/CONFIGURATION.md)** — every setting, and the two worth understanding before enabling them. ([中文](./docs/CONFIGURATION.zh.md))
- **[docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md)** — symptoms, causes, what to check. Includes the plain-language limits of what this plugin can do. ([中文](./docs/TROUBLESHOOTING.zh.md))
- **[docs/UPGRADING.md](./docs/UPGRADING.md)** — upgrading, including the 1.7.x settings migration. ([中文](./docs/UPGRADING.zh.md))
- **[docs/INTERNALS.md](./docs/INTERNALS.md)** — how it works and why it is built this way: the diagnostics it measures with, the h2 transport, the pre-transmission pool, HTTP/3 and signed bodies, and why this cannot be a dynamic plugin. The honest limits live here.
- **[docs/CONTRIBUTING.md](./docs/CONTRIBUTING.md)** — the test suite, and the habits that have actually found bugs here.
- **[CHANGELOG.md](./CHANGELOG.md)** — release notes.

## License

[MIT](./LICENSE)
