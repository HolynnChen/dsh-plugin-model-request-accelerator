# Changelog

Three-part versions. The panel's **检查更新** button compares the installed
`package.json` with the one on `main`, so an entry here is worth a release only when
something a user can see has changed.

## 2.2.0

- **The README is now for using the plugin, and the depth moved into `docs/`.** It had
  grown to four times the length of its own Chinese translation, and the material aimed
  at someone *operating* the plugin was mixed in with material aimed at someone
  *modifying* it — CSS quirks, undici diagnostic scoping, why a dynamic Cordis plugin
  cannot work. Both audiences were served badly by that. The README is now 180 lines:
  what it does, install, configure, confirm, and a troubleshooting section organised by
  symptom.

  Five documents carry the rest: **[CONFIGURATION](./docs/CONFIGURATION.md)** for every
  setting and the two worth understanding before enabling them,
  **[TROUBLESHOOTING](./docs/TROUBLESHOOTING.md)** for symptoms and the plain-language
  limits, **[UPGRADING](./docs/UPGRADING.md)**, **[INTERNALS](./docs/INTERNALS.md)** for
  how it works and why, and **[CONTRIBUTING](./docs/CONTRIBUTING.md)** for the suite and
  the habits that have actually found bugs here. `CONFIGURATION`, `TROUBLESHOOTING` and
  `UPGRADING` have Chinese editions (`*.zh.md`), and the Chinese README links to them.

  No behaviour changed. If you were reading the README for the timing column list or the
  h2 rationale, it is in `docs/` now, with the same content.

- Fixes a duplication introduced by the 2.1.1 edit, which had left everything from
  `## Updating` to the end of the English README present **twice**.

## 2.1.1

- Documentation only — no behaviour changed. The upgrade section now answers the
  question people actually ask, which is what *they* have to do: a table of the three
  starting points (including the one that needs nothing, because 2.1.0's `Config` is
  importable and dsh's own import now handles a straight 1.7.x upgrade), what the
  migrator prints and what its exit codes mean, and an explicit list of what it will
  not do.

  One correction to the 2.1.0 entry below, which reasoned from a single copy: the
  timestamped backup is **not** the usual place the stranded section is found. dsh
  renames the document before writing anything and a section the import rejects stays
  in the renamed file, so `.imported` normally holds it — and the backups are consulted
  because `.imported` is an ordinary file a user can edit or delete.

## 2.1.0

- **Upgrading from 1.7.x carries your settings across.** 1.7.x kept them in
  `$DSH_HOME/settings.yaml`, keyed by this plugin's section id; 2.0 reads them from the
  loader row's `config` instead. dsh's own migration moved every section *except this
  one*, because it only imports sections whose plugin entry exposes a `Config` with a
  volatile field — and 1.7.x's Host half registered none, having called
  `settings.installSection`, which 0.2 removed. So an upgrade booted with every default,
  the settings page had no row to write to, and saving anything failed with
  `Configuration for "model-request-accelerator" is overridden by a home patch or
  command-line overlay`. The installer now moves the stranded section into the row.
  `scripts/migrate-legacy-settings.mjs` does the work; it is idempotent, it keeps only
  the fields this version still declares, and **it never touches a row that already
  carries settings** — the settings page writes that same block, so a stale file must
  not win against a live edit. Run it by hand any time to see what it would do:

  ```sh
  node scripts/migrate-legacy-settings.mjs --profile web --dry-run
  ```

  It consults `settings.yaml`, then `settings.yaml.imported`, then any
  `settings.yaml.bak-*`. dsh renames the file rather than copying it, so a section the
  import rejects stays in `.imported` and that is normally where it is found; the
  backups are the tail, because `.imported` is an ordinary file a user can edit or
  delete, and losing the section from it leaves the backup as the only copy. Nothing in
  dsh 0.2 writes a `.bak-<stamp>` name, so that leg is best-effort by nature. A field the current
  schema has dropped is dropped rather than guessing, a provider whose policy holds
  nothing this version reads is reported rather than written as an empty object, and an
  absent field stays absent so the schema's default still applies.

## 2.0.3

- **HTTP/2 works again, and the tests that cover it pass.** The transport resolved
  undici by walking up from its own file, with the comment that an installed plugin
  lives at `<profile>/plugins/<name>/` so Node reaches the profile's hoisted tree. That
  holds for a copy, not for a plugin installed by link: Node resolves the link's real
  path — the checkout — where nothing named `undici` exists, so `loadUndici()` returned
  undefined, HTTP/2 was skipped, and the process used Node's own transport. The copy is
  now also resolved through dsh's own resolution and through `DSH_PROFILE_DIR`, which
  reaches the profile's tree either way.

## 2.0.2

- **The per-provider switches can be written.** With the section projected, saving one
  was refused with `Config field "providers.sg.enabled" is not volatile`: only volatile
  fields are writable, and schemastery rejects the marker on a field inside a dict —
  its path is a wildcard. The **dict itself** is at a fixed path, so `providers` is
  marked volatile now, which makes every path beneath it writable. That was the marking
  I had removed a release ago as the safer choice, and it was the one that mattered.
- The section unwrap already handles it: the dict validates into the same accessor
  shape as any volatile field, and the whole host suite activates with that shape.

## 2.0.1

- **The settings page is editable again.** The settings service only projects a plugin
  whose `Config` has at least one field marked `.volatile()` — `volatileForm()` returns
  `undefined` otherwise and the entry is dropped from the document the page reads, so
  the page found no entry of its own and disabled every control. That was the whole
  cause; earlier attempts at it (registration, bundle packaging, page policy) were all
  measured and all wrong. The section-level fields are marked now, through the same
  `@deepseek-ai/schemastery` the shipped plugins use.

  Marking is not free: a volatile field validates into a live accessor
  (`{ get, [Symbol(cosmokit.volatile.write)] }`) rather than a plain value, so reading
  the section directly would have seen an object where it expects a boolean and quietly
  stopped compressing. The section is unwrapped once before anything reads it, and
  because the test fixture activates with the same validated config, the whole host
  suite covers that path.

- Volatile is only legal at a fixed path: schemastery rejects it inside the providers
  dict, which is why the per-provider switches are edited through paths rather than
  declared live.

## 2.0.0

**Settings now live in the loader row's `config`. Read the second item before upgrading.**

- **The plugin registers the way the current service works.** The Host half called
  `settings.installSection`, which no longer exists. Nothing threw — the Host's own
  routes stayed up — but no section was registered either, so the settings document
  the page reads had no entry for this plugin: its page rendered with every provider
  switch off and disabled, and no way to turn the timing panel on. A plugin that
  exports `Config` is projected by the settings service now, and its live values
  arrive as `apply`'s second argument; this does that, using the `Config` export that
  was already there.
- **Move your settings into the row.** DSH 0.1 kept them in `settings.yaml`, and 0.2
  imports that file into each entry's `config` — but only for entries whose plugin
  registered a `Config`, which this one never did, so its section was left behind (it
  is still readable in `~/.dsh/settings.yaml.imported`). Add a `config:` block:

  ```yaml
      - id: dsh-plugin-model-request-accelerator
        name: '/absolute/path/to/lib/index.js'
        config:
          providers:
            sg:
              enabled: true
              prewarm: true
          encoding: auto
          prewarmHoldMs: 120000
          prewarmPoolSize: 5
          timing: true
  ```

  Anything left out takes its default: every provider disabled, `encoding` `auto`, a
  pool of 3, a hold of 120000ms, `timing` on.
- The endpoint index reads other plugins' namespaces from the settings document, since
  the service has no per-key read, and refreshes on `settings/document-updated` rather
  than the old `settings/updated`.
- The installer writes `config: {}` into the row it adds.

## 1.7.6

- **The settings entry is matched wherever its name sits in the id.** The live entry
  here is `include:dsh-plugin-model-request-accelerator` — the composed id carries the
  include and the package prefix — and the previous lookup matched only an exact id or
  a `-`-suffixed one. It now matches on the name as a substring, which covers every
  prefix shape, and the client tests use this profile's composed id so the matching is
  what they exercise.
- When nothing matches, the client says so on the console and lists the ids it was
  offered. A wrong id is then a message rather than a page of dead controls.

## 1.7.5

- **The page's controls work again.** The Host keys a settings section by the profile
  entry id — the loader row's id, which is `dsh-plugin-model-request-accelerator` for a
  row named after the package and `model-request-accelerator` for one the installer
  wrote. The client looked up one hardcoded key, found no entry, and rendered the page
  as if settings were read-only: every provider switch off and disabled, the timing
  panel unable to be enabled. It now finds its entry by id (exact, or suffixed with
  the package prefix) and reads writability from that entry rather than from a
  document-level flag this release does not set.
- The provider list itself comes from the directory the Host reports, so
  `deepseek-account` appearing there is the updated DSH registering a provider, not
  this plugin inventing one.

## 1.7.4

- **The settings page is a page in the settings list**, beside General, Models and
  Plugins, rather than a tab inside the Plugins section. The registration in that tab
  strip was live and active — the live slot tree showed it beside the shipped entry —
  but the tab strip is where the inventory lives, and the page belongs with the other
  pages. The seat is `settings.section`, whose entries become the settings panel's own
  nav rows; the shell supplies no title there, so the page renders its own heading
  again.
- Both READMEs named Settings → Plugins, which was the placement for one release.


- **The settings page is reachable again.** DSH 0.2.0-rc.2 rebuilt the Plugins
  settings section around tabs — one page per registered entry, keyed by an id the
  registrant chooses — and removed the per-plugin collapsible card slot this plugin
  registered into. That registration went nowhere, so the plugin was installed,
  running and simply absent from the interface. It now registers a page in
  `settings.plugins.tab`, beside the shipped entries, and the disclosure machinery the
  old card carried is gone with the card. The Request timing view is unaffected:
  `conversation.view` still exists with the same registration options.
- Both READMEs said the card lived in Settings → Plugins → Configuration, which no
  longer names anything.


- **Works with DSH 0.2.0-rc.2 again.** The client half injected a `settingsScope`
  service, which that release no longer provides, so its fiber stayed `pending`
  forever and the browser boot failed with "1 entry did not activate" — taking the
  whole page down, not just this plugin's card. The client half now injects only the
  four services that exist, and drives its view's visibility from a read of its own
  namespace plus a signal from its own writes, which is the only writer there is.
- The installer also recognises a row whose id carries the `dsh-plugin-` package
  prefix, so re-running it cannot add a second row for the same plugin.

## 1.7.1

Six defects the 1.7.0 release carried, all found by looking at a real session's
ledger rather than at the tests — every one of them passed with the suite green.

- **Pre-transmission never used HTTP/2.** A held member's connection is opened in the
  `previous` step's async scope by `openMember`, which called `rawFetch` — the built-in
  transport — so the entire pool sat on HTTP/1.1 while the requests that later claimed
  those members travelled over h2. That silently gave up the header compression and
  multiplexing which are the only things h2 pays for here. It went unnoticed because a
  gateway that speaks both answers http/1.1 happily; an h2-only endpoint failed the
  handover outright. Members now go through the same transport decision as any other
  model request, and the descriptor carries the attributed provider, because a member
  has no ambient scope to resolve a policy from and endpoint matching does not know a
  route's `http2` setting.
- **A pre-transmitted row could not report its protocol.** Its connection was
  negotiated when the member was *opened*, and no connection event fires again for the
  connection it then reuses, so the row reported nothing. The transport now hands back
  what it already knows for an origin. With pre-transmission on, this was every row.
- **A cleartext upgrade overwrote its own outcome.** An h2c upgrade announces two
  connections on one origin and port in order — the http/1.1 socket it starts as, then
  the h2 session it became — so "the last announcement wins" recorded `h1` for requests
  that really did travel over h2. `h2` now wins whenever it is mentioned at all.
- **A held member was listened for at the wrong time.** Its caller deliberately does not
  await the response — a member is *meant* to stay open — so the connection it opened was
  announced after the listener had already been removed, and the member was remembered as
  having negotiated nothing. The listener now lives exactly as long as the send.
- **One failure no longer condemns an endpoint.** A reset stream, or a socket reclaimed
  while it was idle, is usually that connection's fault rather than the endpoint's, and
  condemning an origin is permanent — so a request is retried once on a fresh connection
  before its origin is written off. The retry stands down for a body that cannot be sent
  twice, because replaying a consumed stream throws `Response body object should not be
  disturbed or locked` — a second failure that would condemn the endpoint for a reason
  that has nothing to do with it, and exactly the shape a held member sends.

## 1.7.0

- **HTTP/2, per provider, with a fallback that cannot be worse than not having it.**
  Node's `globalThis.fetch` speaks HTTP/1.1 only — its dispatcher is the built-in
  undici's own Agent, which never passes `allowH2`, and that Agent class is not
  reachable from application code — so the swap is made by driving dsh's own `undici`
  package: its `fetch` with its own `Agent({ allowH2: true })`. The two instances must
  never be crossed (an 8.x Agent with the built-in 7.x fetch fails with
  `invalid onRequestStart method`), which is the rule `lib/transport.js` enforces.
- It is **on by default for a route that pre-transmits**, because pre-transmission is
  what actually pays for it: it re-sends the same multi-kilobyte headers every step,
  and h2 sends only the delta, while the held pool shares one multiplexed connection.
  A route that does not pre-transmit has to ask. `http2: false` at the section level
  is a kill switch; `allowInsecureH2c` (default off) extends it to `http://` endpoints
  over a cleartext h2c connection.
- **Degradation is ALPN's, not a retry loop**: an endpoint that does not offer h2
  simply stays on http/1.1 through the same Agent, with no error. What is left is a
  transport that fails outright — one failure condemns that origin for the life of the
  plugin, so the cost is one extra round trip ever rather than one per request.
- **The protocol is remembered per origin, because undici reports it once per socket.**
  `undici:client:connected` fires when a connection is *established*, so on a pooled
  keep-alive connection only the request that opened it ever sees it — reading the
  protocol from that event alone left every later row claiming nothing while the
  requests really did travel over h2. It is now cached per origin for the life of the
  connection, cleared when an origin's attempt fails (the announced version must still
  be committed only after a send succeeds, since a refused cleartext upgrade announces
  `h2` and then fails), and a fresh announcement still wins over the cached one.
- **A fixed silent bug under h2.** undici hands HTTP/1.1 response headers over as a
  flat list but HTTP/2 ones as a plain object, and the reader only understood the
  list. Nothing failed loudly — the timing panel simply reported no `content-encoding`
  on every h2 reply, which looks like a gateway that does not compress. Both shapes
  are read now.
- The timing row reports the protocol that **actually carried** the response, which
  had to be learned rather than read off the response: undici's `Response` has no
  `httpVersion`, and its `client:connected` diagnostic announces `h2` *before* a
  cleartext upgrade is proven, so an attempt the far end refuses announces `h2` and
  then fails. The announced version is only recorded once the send has succeeded —
  a test pins exactly that, because the first draft got it wrong.
- **HTTP/3 is not offered, and cannot be on this stack**: undici contains no HTTP/3
  or QUIC code, and Node 24.12 ships neither `nghttp3` nor `ngtcp2`. A hand-built
  HTTP/3 transport would cost every undici diagnostic the timing view and the
  pre-transmission pool rest on.

## 1.6.1

- **The installer no longer produces an unparseable patch layer from a pristine
  profile.** A fresh `cordis.patch.yml` is comments followed by an empty array, and
  appending the loader entry after `[]` makes a document YAML rejects — it reads one
  document that is both an empty array and a block sequence, so the profile fails to
  compose. The installer now removes the empty array and puts the entry in its place,
  keeping the comments.
- `test/install.test.mjs` runs the installer twice against throwaway profiles from
  four starting states, which is what the fix is verified by.



- **The compression algorithm is chosen per provider, in the settings table**, instead
  of once for the whole plugin. Two routes behind one gateway can now differ — one
  pinned to gzip because that relay is known to dislike brotli, the other left on
  `auto`. The section-wide `encoding` remains as the default a route inherits until it
  sets its own, so existing `settings.yaml` files keep working unchanged.
- The Host already compiled a per-provider `encoding`; only the card did not offer it,
  which is why this is a UI change with a test that proves the two routes really do go
  out differently.



- The ledger row also reports **how many pre-transmitted requests the plugin is
  holding right now**. Those are the connections this plugin owns; anything beyond
  them belongs to undici's keep-alive pool or to the operating system, which is worth
  being able to tell apart when a network tool shows more sockets than the pool size
  suggests.


- **The settings card shows what the timing ledger occupies** — how many sessions it
  covers and how many bytes its stored documents make up — and offers a button to
  clear it. Clearing asks for confirmation first, then removes the stored documents
  (including sessions this process never loaded) and what the running process holds.
  It cannot be undone, and the card says so.
- The per-conversation cap on held requests now counts the pool it has just filed.
  It ran before that write, so the total settled one pool above the bound it claims.



A full read of every file, and the corrections it turned up. Most were documentation:
sentences describing mechanisms that had been removed, or describing current behaviour
backwards. Three of them were things a user reads.

- **The cache column's formula was stated wrongly in its tooltip.** It said the share
  is `cache reads ÷ input`, but `inputTokens` counts *uncached* input only, so that
  divides by too small a number. The divisor is cache reads plus uncached input. The
  README, the calculation and the panel now agree.
- **Two pre-transmission miss reasons were misleading.** One blamed "a gateway closing
  an idle connection" for a failure traced to a pool race; the other said the history
  changed "例如压缩", where 压缩 reads as either request-body compression or context
  compaction.
- **The settings schema's own description of `prewarmPoolSize`** said how many
  conversations may hold a request, which is the opposite of what it does — it is how
  many held requests one conversation keeps. This is the text the settings UI shows.
- Reading the sources removed dead code: a `dropPoolFor` with no caller, per-chunk
  bookkeeping left from the removed assistant-turn prediction, an unused constant, an
  unused threshold handler, and six style objects for markup that no longer exists.
- Two tests that named behaviour they no longer exercised were made to exercise it, and
  a third was renamed to what it actually checks.

## 1.3.2

- The compression switch's tooltip was still the size threshold's text, describing a
  control that is no longer in the card.
- The READMEs said a child agent's pool is kept or released according to queued input,
  which stopped being true when that check was removed.

## 1.3.1

- The size threshold is no longer offered in the card; it stays a schema field.
- The provider column leads the table, takes the slack, and the two switches sit at its
  right edge; the table spans the panel.
- The two switch headings are centred, with tooltips explaining what each switch does.

## 1.3.0

- The settings card reports, per endpoint, what real traffic has established: whether a
  compressed body was refused, whether pre-transmission was switched off, and how many
  compressions have failed in a row. Observations only — nothing is sent to produce it.

## 1.2.x

- **1.2.1** — README section on what the plugin cannot do (signed bodies, transports
  that bypass `fetch`, decoders that refuse an encoding), a guard that leaves an
  AWS-signed body alone, and `scripts/probe-encodings.mjs` to ask an endpoint which
  encodings it decodes before trusting it.
- **1.2.0** — Responses-shaped bodies (`input`) are supported alongside
  chat-completions and Anthropic ones (`messages`); a body whose conversation is not an
  array is reported as 不适用 rather than as an empty pool.

## 1.1.x

- **1.1.2** — opening the settings card checks for an update and says so.
- **1.1.1** — removed the dead assistant-turn prediction helpers and the text around
  them.
- **1.1.0** — a three-part version with an update button; the fixed fields are moved
  behind the conversation so the prefix can carry them; a turn boundary stops releasing
  the pool; a mismatch records where the bytes parted company.
