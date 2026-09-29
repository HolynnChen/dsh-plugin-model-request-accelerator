# Contributing

## Tests

```bash
npm test
```

The suite runs on `node --test`, one file per concern. It needs the package's dependencies resolvable, which a profile-based install provides; a bare checkout needs `npm install`.

| Suite | Covers |
| --- | --- |
| `test/host.test.mjs` | The real `apply()` against a fake Cordis context and a spied `globalThis.fetch`: schema resolution, the settings contract, `llm/stream` attribution, and the fetch rewrite. Its fixture deliberately reproduces the awkward case — two routes sharing one endpoint — to prove a switch is genuinely per-provider. It also measures a **real** request end to end, against a local SSE endpoint whose think time, first-token delay and decode window are separated on purpose. |
| `test/client.test.mjs` | The real browser bundle under a stubbed module loader and a hook-tracking React stand-in, so it can render the card, click it, and re-render: bundle id, registration, the collapsed start, the timing switch, and the view being added and removed as the preference changes. |
| `test/timing.test.mjs` | The phase arithmetic with injected clocks, so every boundary is asserted at an exact millisecond, including the phases that are genuinely absent. |
| `test/prewarm.test.mjs` | The prefix scanner and the field reordering against bodies of both shapes, including the ones that must be refused. |
| `test/transport.test.mjs` | The h2 decision and its fallback, with both injection points faked so none of it needs a network: the TLS and opt-in rules, one Agent per origin, the refusal to cross two undici instances, a failure condemning an origin exactly once, an abort *not* condemning it, and the announced-but-failed connection that must not be reported as a protocol. |
| `test/version.test.mjs` | Three-part comparison, including the cases a string comparison gets wrong and the ones that must never be read as an update. |
| `test/install.test.mjs` | The installer against throwaway profiles, twice each, from a pristine patch layer, one that already has entries, an empty file and no file at all — pinning that an empty array is replaced rather than appended to, and that a 1.7.x upgrade gains its settings exactly once. |
| `test/migrate.test.mjs` | The migration: the section found in `.imported` and in a backup, a row that already carries settings left untouched, a malformed patch refused rather than half-written, an absent field staying absent, and the stated provider field list failing the build when it drifts from the schema. |

## A note on how bugs have actually been found here

The suite is necessary and not sufficient. Six defects reached a release while it was green, and every one was found by reading a real deployment's data rather than by adding a test:

- undici resolved by guessing a path, leaving **h2 silently off** in a real install;
- h2 response headers have a different shape from h1's, silently dropping `content-encoding`;
- undici announces `h2` **before** a cleartext upgrade is proven, labelling a failed request as h2;
- undici reports a connection **once per socket**, so only the first request on a connection learned its protocol;
- a pre-transmitted row could not report a protocol at all, because the connection was negotiated when the member was *opened*, in another async scope;
- held members were opened on the built-in transport, so the whole pool silently sat on HTTP/1.1 while the rows claimed h2.

Five of those share one root cause: **transport diagnostics are socket-scoped while the code treated them as per-request.** When you touch measurement or protocol reporting, assume the diagnostic fires once per socket and in an async context that is not yours.

Two habits follow from that, and they are the useful part of this document:

1. **A green suite does not mean the feature is on.** Verify against a running deployment — check the ledger, the settings card, the log line. Several of these bugs were invisible until real traffic ran through them.
2. **When you fix one of these, add the test that would have caught it.** The suite is how the next person avoids re-learning it.

## Style

- Comments explain **why**, not what. The codebase's most useful comments record a measurement, a bug, or a constraint that is not visible from the code — a class of comment worth preserving.
- `lib/compress.js`, `lib/timing.js`, `lib/prewarm.js` and `lib/version.js` are pure and have no Cordis or global dependencies. Keep them that way: it is what makes them directly testable.
- The browser half is a plain CJS factory: no JSX, no ESM syntax.
- Both READMEs are user-facing documentation. `README.zh.md` is a translation of `README.md`, and `docs/` holds the deeper material. A behaviour change that a user can see belongs in the README or the relevant `docs/` file, and in `CHANGELOG.md`.
