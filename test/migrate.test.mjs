/**
 * Contract test for the 1.7.x settings migration.
 *
 * dsh 0.2 renames `settings.yaml` to `settings.yaml.imported` *before* it writes
 * anything, then imports the sections whose plugin entry exposes a `Config` with a
 * volatile field. A section that is rejected is logged and stays in the renamed file —
 * so `.imported` is normally where a stranded section is found.
 *
 * A backup is the other way it turns up, and it is a real one rather than a curiosity:
 * `.imported` is an ordinary file that a user can edit or delete, so the section can be
 * gone from it by the time anyone looks — which is what happened on the install this
 * was written from. Nothing in dsh 0.2 writes a `.bak-<stamp>` name, so that leg is
 * best-effort by nature. The migrator consults a list rather than assuming one source,
 * and both spellings are covered below.
 *
 * The second property is that it must never overwrite settings the settings page
 * could have written: both write the same block, and a stale file must not win
 * against a live edit.
 *
 * Run: npm test (from the package root; the script lists every suite)
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { acceptedKeys, findLegacy, findRow, hasConfig, legacyCandidates, migrate, toRowConfig } from "../scripts/migrate-legacy-settings.mjs";
import { parseDocument } from "yaml";

/** Passed where the script would load `yaml` itself, so the fixtures stay in one place. */
const yaml = { parseDocument };

const PLUGIN_ID = "model-request-accelerator";
const MIGRATED = 0;
const NOTHING_TO_DO = 3;
const FAILED = 1;

/** The legacy section as 1.7.x held it, with a field no longer declared. */
const LEGACY_SECTION = `model-request-accelerator:
  providers:
    sg:
      enabled: true
      prewarm: true
      encoding: auto
      http2: false
    codebuddy:
      enabled: true
      prewarm: false
      http2: false
    old-provider:
      removedKnob: 1
  encoding: gzip
  http2: false
  removedField: 12
ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
`;

/** A patch layer whose plugin row is registered the way the installer writes it. */
const PATCH = `# Your patch layer for this web profile.
[]
`;

/** A patch layer that already registers the plugin, in the installer's insert form. */
const PATCH_REGISTERED = `# Your patch layer.
- insert:
    - id: ${PLUGIN_ID}
      name: './plugins/${PLUGIN_ID}/lib/index.js'
      config: {}
- id: llm-pi-ai
  config:
    providers: {}
`;

/**
 * Build a throwaway DSH home with a profile patch and optional legacy files.
 * @param options - the patch text, and which legacy files to write.
 * @returns the home directory and the profile directory.
 */
function home(options = {}) {
	const root = mkdtempSync(join(tmpdir(), "dsh-migrate-"));
	const profile = join(root, "profiles", "web");
	mkdirSync(profile, { recursive: true });
	writeFileSync(join(profile, "cordis.patch.yml"), options.patch ?? PATCH_REGISTERED);
	if (options.live !== undefined) writeFileSync(join(root, "settings.yaml"), options.live);
	if (options.imported !== undefined) writeFileSync(join(root, "settings.yaml.imported"), options.imported);
	if (options.backup !== undefined) writeFileSync(join(root, "settings.yaml.bak-20260927-113734"), options.backup);
	return { root, profile };
}

/** Read the migrated patch and the row's config. @param profile - the profile directory. @returns the file text and the parsed row's config. */
function readBack(profile) {
	const text = readFileSync(join(profile, "cordis.patch.yml"), "utf8");
	const document = parseDocument(text);
	const found = findRow(document, PLUGIN_ID);
	return { text, config: found?.row.get("config")?.toJSON() };
}

test("migrates the section out of a timestamped backup, when that is the only copy left", async () => {
	const { root, profile } = home({ backup: LEGACY_SECTION, imported: "ui-onboarding:\n  welcomeNoticeVersion: 1\n" });
	try {
		const result = await migrate({ dshHome: root, profile: "web", pluginId: PLUGIN_ID, dryRun: false });
		assert.equal(result.code, MIGRATED, `expected a migration, got ${String(result.code)}: ${result.reason ?? ""}`);
		assert.match(result.source, /settings\.yaml\.bak-20260927-113734$/u, "the backup is the source when it is the only copy left");

		const { text, config } = readBack(profile);
		assert.equal(config.providers.sg.enabled, true, "the switch survives");
		assert.equal(config.providers.sg.prewarm, true);
		assert.equal(config.providers.sg.encoding, "auto", "a per-provider algorithm survives");
		assert.equal(config.providers.sg.http2, false, "so does an explicit opt-out");
		assert.equal(config.providers.codebuddy.enabled, true);
		assert.equal(config.encoding, "gzip", "and a section default");
		assert.equal(config.http2, false, "including the plugin-wide kill switch");
		// A provider whose policy holds nothing this version reads is reported rather
		// than written as an empty object; one that still has a recognised field is
		// kept, because `enabled` is the switch the user set.
		assert.deepEqual(result.dropped, ["old-provider"], "a provider with no field this version reads is reported, not guessed at");
		assert.equal(Object.hasOwn(config, "removedField"), false, "a field the schema dropped is not carried over");
		assert.match(text, /^# Your patch layer\./mu, "the file's own comments survive");
		assert.match(text, /id: llm-pi-ai/u, "and so does every other row");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("never overwrites settings the settings page could have written", async () => {
	const configured = `- insert:\n    - id: ${PLUGIN_ID}\n      name: './plugins/x/lib/index.js'\n      config:\n        providers:\n          sg:\n            enabled: false\n`;
	const { root, profile } = home({ patch: configured, backup: LEGACY_SECTION });
	try {
		const before = readFileSync(join(profile, "cordis.patch.yml"), "utf8");
		const result = await migrate({ dshHome: root, profile: "web", pluginId: PLUGIN_ID, dryRun: false });
		assert.equal(result.code, NOTHING_TO_DO, "a row that already carries settings is left alone");
		assert.match(result.reason, /already carries settings/u);
		assert.equal(readFileSync(join(profile, "cordis.patch.yml"), "utf8"), before, "and the file is not rewritten at all");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("is idempotent: a second run changes nothing", async () => {
	const { root, profile } = home({ backup: LEGACY_SECTION });
	try {
		assert.equal((await migrate({ dshHome: root, profile: "web", pluginId: PLUGIN_ID, dryRun: false })).code, MIGRATED);
		const afterFirst = readFileSync(join(profile, "cordis.patch.yml"), "utf8");
		const second = await migrate({ dshHome: root, profile: "web", pluginId: PLUGIN_ID, dryRun: false });
		assert.equal(second.code, NOTHING_TO_DO, "the second run has nothing left to do");
		assert.equal(readFileSync(join(profile, "cordis.patch.yml"), "utf8"), afterFirst, "and leaves the migrated file byte-identical");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a dry run reports the migration without writing it", async () => {
	const { root, profile } = home({ backup: LEGACY_SECTION });
	try {
		const before = readFileSync(join(profile, "cordis.patch.yml"), "utf8");
		const result = await migrate({ dshHome: root, profile: "web", pluginId: PLUGIN_ID, dryRun: true });
		assert.equal(result.code, MIGRATED);
		assert.match(result.text, /enabled: true/u, "the result is reported");
		assert.equal(readFileSync(join(profile, "cordis.patch.yml"), "utf8"), before, "but the file is untouched");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("reports each case it cannot migrate, without failing the install", async () => {
	// No profile patch at all.
	const missing = mkdtempSync(join(tmpdir(), "dsh-migrate-"));
	try {
		const result = await migrate({ dshHome: missing, profile: "web", pluginId: PLUGIN_ID, dryRun: false });
		assert.equal(result.code, NOTHING_TO_DO);
		assert.match(result.reason, /no patch file/u);
	} finally {
		rmSync(missing, { recursive: true, force: true });
	}

	// A patch with no row for this plugin.
	const absent = home({ patch: "- insert:\n    - id: other\n      name: './plugins/other/lib/index.js'\n", backup: LEGACY_SECTION });
	try {
		const result = await migrate({ dshHome: absent.root, profile: "web", pluginId: PLUGIN_ID, dryRun: false });
		assert.equal(result.code, NOTHING_TO_DO);
		assert.match(result.reason, /no "model-request-accelerator" row/u);
	} finally {
		rmSync(absent.root, { recursive: true, force: true });
	}

	// A row, but nothing legacy anywhere.
	const empty = home({});
	try {
		const result = await migrate({ dshHome: empty.root, profile: "web", pluginId: PLUGIN_ID, dryRun: false });
		assert.equal(result.code, NOTHING_TO_DO);
		assert.match(result.reason, /no legacy settings section/u);
	} finally {
		rmSync(empty.root, { recursive: true, force: true });
	}

	// A legacy section whose every field this version has dropped.
	const stale = home({ backup: `${PLUGIN_ID}:\n  removedField: 1\n` });
	try {
		const result = await migrate({ dshHome: stale.root, profile: "web", pluginId: PLUGIN_ID, dryRun: false });
		assert.equal(result.code, NOTHING_TO_DO);
		assert.match(result.reason, /no field this version still reads/u);
	} finally {
		rmSync(stale.root, { recursive: true, force: true });
	}
});

test("refuses to write a patch file it cannot parse", async () => {
	const { root } = home({ patch: "- insert:\n  - id: [unclosed\n" });
	try {
		const result = await migrate({ dshHome: root, profile: "web", pluginId: PLUGIN_ID, dryRun: false });
		assert.equal(result.code, FAILED, "a malformed patch is a real failure, not a silent no-op");
		assert.match(result.reason, /YAML/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("finds the row whether it is a top-level entry or inside an insert list", () => {
	for (const [label, patch] of [
		["insert form", PATCH_REGISTERED],
		["flat form", `- id: ${PLUGIN_ID}\n  name: './plugins/x/lib/index.js'\n  config:\n    encoding: gzip\n`],
		["dsh-plugin- prefixed", `- insert:\n    - id: dsh-plugin-${PLUGIN_ID}\n      name: './plugins/x/lib/index.js'\n`]
	]) {
		const found = findRow(parseDocument(patch), PLUGIN_ID);
		assert.notEqual(found, undefined, `${label}: the row is found`);
	}
	const found = findRow(parseDocument(PATCH_REGISTERED), PLUGIN_ID);
	assert.equal(hasConfig(found.row), false, "an empty config counts as no settings");
});

test("consults the legacy candidates in the order that finds the section", () => {
	const { root } = home({ imported: "ui-onboarding: {}\n", backup: LEGACY_SECTION });
	try {
		const candidates = legacyCandidates(root);
		assert.equal(candidates[0], join(root, "settings.yaml"), "the live file is tried first");
		assert.equal(candidates[1], join(root, "settings.yaml.imported"), "then what dsh renamed it to");
		assert.ok(candidates.length >= 3, "then the timestamped backups");
		const found = findLegacy(candidates, PLUGIN_ID, yaml);
		assert.match(found.path, /settings\.yaml\.bak-/u, "and the section is found wherever it actually is");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("keeps an absent field absent, so the schema's default still applies", () => {
	const keys = { section: ["providers", "encoding", "http2"], provider: ["enabled", "prewarm"] };
	const { config } = toRowConfig({ providers: { sg: { enabled: true } } }, keys);
	assert.deepEqual(config, { providers: { sg: { enabled: true } } }, "no default is pinned into the row");
	assert.equal(Object.hasOwn(config, "encoding"), false, "an unset section field stays unset");
	assert.equal(Object.hasOwn(config.providers.sg, "prewarm"), false, "and an unset provider field too");
});

test("reads the section's field names from the plugin's own schema", async () => {
	const keys = await acceptedKeys();
	assert.equal(keys.status, "schema", "the schema imports from the package's own dependency");
	assert.deepEqual(
		[...keys.section].sort(),
		["allowInsecureH2c", "encoding", "http2", "prewarmHoldMs", "prewarmPoolSize", "providers", "timing"],
		"the section's keys are the schema's, so a field this plugin gains is migratable without touching the script"
	);
});

test("keeps the stated provider field list in step with the schema", async () => {
	// The provider names are stated in the script rather than read from the schema: they
	// live under `providers.inner`, which is schemastery's internal shape for a `Dict`
	// and not a surface worth depending on at runtime. This is the test that fails when
	// the schema moves and the statement does not, which is the only thing standing
	// between a renamed field and a silently dropped setting.
	const { Config } = await import("../lib/index.js");
	const declared = Object.keys(Config.dict.providers.inner.dict ?? {});
	const keys = await acceptedKeys();
	assert.deepEqual(
		[...keys.provider].sort(),
		[...declared].sort(),
		"the script's provider field list matches what the plugin actually accepts"
	);
});

test("finds the section where dsh actually leaves it: in the renamed file", async () => {
	// dsh renames the document before writing anything and a rejected section stays in
	// the renamed file, so this is the ordinary shape of the problem — the plugin's row
	// exists, the settings page has nothing, and the values are sitting in `.imported`.
	const { root, profile } = home({ imported: LEGACY_SECTION });
	try {
		const result = await migrate({ dshHome: root, profile: "web", pluginId: PLUGIN_ID, dryRun: false });
		assert.equal(result.code, MIGRATED, `expected a migration, got ${String(result.code)}: ${result.reason ?? ""}`);
		assert.match(result.source, /settings\.yaml\.imported$/u, "the renamed file is the source");
		const { config } = readBack(profile);
		assert.equal(config.providers.sg.enabled, true, "and its values land in the row");
		assert.equal(config.encoding, "gzip");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("prefers the live settings file over the renamed one", async () => {
	// Both can be present: dsh leaves `.imported` behind, and a user who wants to change
	// a setting by hand may put a fresh settings.yaml next to it. The live file is the
	// newer statement of intent, so it wins — and the other sections in it are left for
	// dsh to import, which is why only this plugin's key is read.
	const live = `${PLUGIN_ID}:\n  providers:\n    sg:\n      enabled: false\nother-plugin:\n  untouched: yes\n`;
	const { root, profile } = home({ live, imported: LEGACY_SECTION });
	try {
		const result = await migrate({ dshHome: root, profile: "web", pluginId: PLUGIN_ID, dryRun: false });
		assert.equal(result.code, MIGRATED);
		assert.match(result.source, /settings\.yaml$/u, "the live file is read, not the leftover");
		const { config } = readBack(profile);
		assert.equal(config.providers.sg.enabled, false, "and its value is what lands in the row");
		assert.equal(Object.hasOwn(config, "encoding"), false, "fields the live file omits are not taken from the stale one");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
