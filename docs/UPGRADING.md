# Upgrading

## Contents

- [Updating within 2.x](#updating-within-2x)
- [Upgrading from 1.7.x](#upgrading-from-17x)
- [Why the migration is needed](#why-the-migration-is-needed)
- [Where it looks for your settings](#where-it-looks-for-your-settings)
- [What the migration will not do](#what-the-migration-will-not-do)

## Updating within 2.x

The settings card shows the version with a button. **Opening the card checks by itself**, and **检查更新** asks again, comparing against the version published on the repository's `main` branch. When the published one is newer, the button becomes **更新到 X** and does a fast-forward pull of the plugin's own directory.

**Restart `dsh web` afterwards.** The Host half is loaded at startup and the live reload does not pick it up; the browser half only needs a page reload. The card says so.

Or just re-run the installer, which does the same pull:

```bash
curl -fsSL https://raw.githubusercontent.com/HolynnChen/dsh-plugin-model-request-accelerator/main/install.sh | sh
```

## Upgrading from 1.7.x

What you have to do depends on where you are coming from, and one of the three cases needs nothing at all.

| Coming from | What happens | What to do |
| --- | --- | --- |
| 1.7.x, upgrading straight to 2.1.0 or later | DSH imports the section itself, because this version's `Config` is one DSH can import | Nothing. Check the settings page shows your providers |
| Already on 2.0.0–2.0.3 | That release registered no importable `Config`, so DSH left your section behind | Re-run the installer, or run the migrator by hand |
| Already on 2.x and the section is gone | `.imported` was edited or deleted after the upgrade | The migrator falls back to a `settings.yaml.bak-*`; if there is none, set your settings up again in the page |

**The installer carries them across by itself**, so for most people upgrading is just running it again. To see what it would do first, or to do it without reinstalling:

```bash
node scripts/migrate-legacy-settings.mjs --profile web --dry-run   # show what it would write
node scripts/migrate-legacy-settings.mjs --profile web             # write it
```

Either way it prints which file it read, so there is nothing to guess at:

```
==> migrated your 1.7.x settings from /Users/you/.dsh/settings.yaml.imported
```

If it says `no settings to migrate: ...` instead, read the rest of the line — it names the reason, and all of the reasons are fine:

- **the row already carries settings** — nothing to do;
- **no `model-request-accelerator` row** — the plugin is not registered yet, so install it first;
- **no legacy settings section to migrate** — there is nothing left to find, so set your settings up in the page.

Exit code `3` means "nothing to do" rather than a failure, which is what the installer keys off. `1` means a real failure — an unreadable or malformed patch, or one that could not be written — and the installer reports it and leaves the file alone.

## Why the migration is needed

1.7.x kept settings in `$DSH_HOME/settings.yaml`, keyed by this plugin's section id. From 2.0 they live in the loader row's `config` instead.

DSH migrates old sections by itself, but only for a plugin entry that exposes a `Config` with a volatile field. 1.7.x's Host half registered none — it called `settings.installSection`, which 0.2 removed — so this plugin's section was the one DSH left behind. The symptom was an upgrade that booted with every provider off, offered no row to configure, and refused a save with:

```
Configuration for "model-request-accelerator" is overridden by a home patch or command-line overlay
```

**2.1.0's `Config` is importable**, so this cannot happen again for anyone upgrading from here.

## Where it looks for your settings

In order:

1. `settings.yaml` — a file a user wrote by hand is the newer statement of intent;
2. `settings.yaml.imported` — where DSH renames the old file, and where a section the import rejected stays, so this is normally where it is found;
3. any `settings.yaml.bak-*`.

That third fallback exists because `.imported` is an ordinary file: editing or deleting it is easy, and doing so leaves a backup as the only copy. Nothing in DSH 0.2 writes a `.bak-<stamp>` name, so that leg is best-effort by nature.

> **If you restore an old `settings.yaml` and restart DSH, the current `.imported` is overwritten** — DSH renames the file over it, with no check and no prompt. Copy `.imported` aside first if you want to keep it.

## What the migration will not do

- **It never overwrites a row that already carries settings.** Both the migrator and the settings page write the same block, so re-running the installer cannot undo a change you made in the page. Every run after the first reports nothing to do.
- **It never invents a value.** A field the current version no longer declares is dropped, and an absent field stays absent so the schema's default still applies instead of being pinned into the row. A provider whose policy holds nothing this version reads is reported rather than written as an empty object.
- **It runs even if you installed the plugin by hand.** It finds `yaml` through DSH's own dependency tree, so it works from a checkout whose dependencies were never installed.
