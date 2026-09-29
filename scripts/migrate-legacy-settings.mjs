/**
 * Carry a 1.7.x settings section into the loader row 2.0 reads.
 *
 * DSH 0.1 kept each plugin's settings in `$DSH_HOME/settings.yaml`, keyed by the
 * plugin's section id. 0.2 imports that file into each loader entry's `config` —
 * but only for entries whose plugin registered a `Config`, and this plugin's Host
 * half never did (it called `settings.installSection`, which 0.2 removed, and
 * nothing threw). So on an upgrade the plugin's whole section was left behind: it
 * is left out of the import, the plugin boots with every default,
 * and the settings page has no row to write to — dsh's config editor refuses the
 * write with "overridden by a home patch or command-line overlay".
 *
 * This reads that stranded section and writes it into the plugin's own row in the
 * profile patch, which is where 2.0 reads configuration from. Every field name and
 * value shape is identical between the two versions — the only change is *where*
 * the object lives — so the migration is a move, not a translation. Fields the
 * current `Config` does not declare are dropped rather than guessed at, and a row
 * that already carries settings is never touched, because the settings page writes
 * into that same block and a stale legacy file must not overwrite a live edit.
 *
 * Exit codes, so the installer can tell the cases apart without parsing output:
 *   0  migrated
 *   3  nothing to migrate (no plugin row, no usable legacy section, or the row
 *      already carries settings) — attempt measured, nothing left to do
 *   1  a real failure: unreadable or malformed YAML, or the patch could not be written
 *
 * Usage:
 *   node scripts/migrate-legacy-settings.mjs --profile web [--dry-run]
 *
 * Options:
 *   --dsh-home <dir>   DSH home                     (default: $DSH_HOME or ~/.dsh)
 *   --profile <name>   profile to migrate           (default: $DSH_PROFILE or web)
 *   --plugin-id <id>   plugin id and legacy section key (default: model-request-accelerator)
 *   --dry-run          print the patch instead of writing it
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

const MIGRATED = 0;
const NOTHING_TO_DO = 3;
const FAILED = 1;

/**
 * Load `yaml`, which this script needs to read the patch without destroying its
 * comments and to write it back safely.
 *
 * It is a dependency of the plugin, so a profile that installed the plugin properly has
 * it — but this script also runs from a fresh clone in a profile whose `node_modules`
 * was never populated, which is exactly the hand-installed upgrade it exists for, and
 * there nothing is reachable from here but dsh itself. So the search is the same shape
 * as `lib/transport.js`'s search for undici: this file's own resolution, then the tree
 * `dsh` itself lives in (which ships `yaml`), then the profile's.
 * @param profileDir - the profile directory, when the caller can name it.
 * @returns the module, or `undefined` when no copy is reachable.
 */
function loadYaml(profileDir) {
	const loaders = [];
	const own = createRequire(import.meta.url);
	loaders.push(own);
	// dsh's package, reached through its own resolution…
	try {
		loaders.push(createRequire(own.resolve("@deepseek-ai/dsh/package.json")));
	} catch {}
	// …or through the `dsh` command a user actually runs, since that is what has a
	// global presence even when nothing about it resolves from a bare clone.
	for (const command of ["dsh", "dsh.cmd"]) {
		try {
			const real = execFileSync(process.platform === "win32" ? "where" : "readlink", process.platform === "win32" ? [command] : ["-f", command], { encoding: "utf8" }).trim().split("\n")[0];
			loaders.push(createRequire(join(resolve(real, "..", ".."), "package.json")));
		} catch {}
	}
	for (const dir of [profileDir, process.env.DSH_PROFILE_DIR]) {
		if (typeof dir !== "string" || dir.length === 0) continue;
		try {
			loaders.push(createRequire(join(dir, "package.json")));
		} catch {}
	}
	for (const loader of loaders) {
		try {
			const loaded = loader(loader.resolve("yaml"));
			if (typeof loaded?.parseDocument === "function") return loaded;
		} catch {}
	}
	return undefined;
}

/**
 * The section's field names, used only when the plugin's own `Config` cannot be
 * imported (its `@deepseek-ai/schemastery` dependency missing). A copy of the
 * schema, so it can rot — the schema is preferred, and this exists so a migration
 * still runs in a tree the plugin itself could not load.
 */
const SECTION_KEYS = ["providers", "encoding", "prewarmHoldMs", "prewarmPoolSize", "http2", "allowInsecureH2c", "timing"];

/**
 * One provider's field names. Unlike the section's these cannot be read off the
 * schema at all — `providers` is a `Dict`, and a `Dict` exposes no inner keys — so
 * this single list is the only statement of them. When it drifts from
 * `lib/index.js`, the schema test in `test/migrate.test.mjs` fails.
 */
const PROVIDER_KEYS = ["enabled", "minBytes", "prewarm", "http2", "encoding"];

/** Parse the migration's arguments. @param argv - process arguments after the script. @returns the options. */
export function readOptions(argv) {
	const options = {
		dshHome: process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== "" ? process.env.DSH_HOME : join(homedir(), ".dsh"),
		profile: process.env.DSH_PROFILE !== undefined && process.env.DSH_PROFILE !== "" ? process.env.DSH_PROFILE : "web",
		pluginId: "model-request-accelerator",
		dryRun: false
	};
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		if (flag === "--dry-run") options.dryRun = true;
		else if (flag === "--dsh-home") options.dshHome = argv[++index];
		else if (flag === "--profile") options.profile = argv[++index];
		else if (flag === "--plugin-id") options.pluginId = argv[++index];
		else if (flag === "--as-command") options.asCommand = true;
		else if (flag === "--help" || flag === "-h") options.help = true;
		else throw new Error(`unknown argument ${JSON.stringify(flag)}`);
	}
	return options;
}

/**
 * The keys a version of this plugin declares, straight from its `Config`, so the
 * migration writes only fields something will read.
 *
 * The section's keys are readable off the schema. The provider's are not: schemastery
 * models `providers` as a `Dict`, whose value shape carries neither `dict` nor
 * `value.dict`, so the inner field names have to be stated. They are stated once,
 * above, and `test/migrate.test.mjs` fails when the schema stops agreeing with them.
 * @returns field names for the section and for one provider entry, and where each came from.
 */
export async function acceptedKeys() {
	try {
		const { Config } = await import(pathToFileURL(join(PACKAGE_ROOT, "lib", "index.js")).href);
		const section = Object.keys(Config.dict ?? {});
		if (section.length === 0) throw new Error("the schema declares no fields");
		return { section, provider: [...PROVIDER_KEYS], status: "schema", providerSource: "stated" };
	} catch (error) {
		return { section: [...SECTION_KEYS], provider: [...PROVIDER_KEYS], status: "fallback", providerSource: "stated", error };
	}
}

/**
 * Keep only the declared keys of a legacy object. An absent key stays absent: the
 * schema's defaults are the right answer for a field the user never set, and writing
 * them would pin a value the user did not choose.
 * @param value - the legacy object.
 * @param keys - the keys to keep.
 * @returns the picked object, or `undefined` when `value` is not an object.
 */
export function pick(value, keys) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const picked = {};
	for (const key of keys) if (Object.hasOwn(value, key)) picked[key] = value[key];
	return picked;
}

/**
 * Carry a legacy section into the shape a loader row's `config` takes in 2.0.
 * @param legacy - the section as `settings.yaml` held it.
 * @param keys - accepted field names.
 * @returns the row config, and the provider names that did not survive.
 */
export function toRowConfig(legacy, keys) {
	const picked = pick(legacy, keys.section) ?? {};
	const providers = {};
	const dropped = [];
	for (const [name, policy] of Object.entries(legacy?.providers ?? {})) {
		const one = pick(policy, keys.provider);
		if (one === undefined || Object.keys(one).length === 0) dropped.push(name);
		else providers[name] = one;
	}
	const config = {};
	if (Object.keys(providers).length > 0) config.providers = providers;
	for (const [key, value] of Object.entries(picked)) if (key !== "providers") config[key] = value;
	return { config, dropped };
}

/**
 * Every file a 1.7.x install could have left the section in.
 *
 * `settings.yaml` is where 1.7.x wrote it. `settings.yaml.imported` is where dsh
 * renames that file, and a section the import rejects stays in the renamed document —
 * so `.imported` is where the section normally still is, and it is consulted second
 * only because a hand-written `settings.yaml` would be the newer statement.
 *
 * The timestamped backups are the tail, and they matter for a reason that is nobody's
 * contract: `.imported` is a file a user can edit or delete, and losing the section
 * from it is exactly the kind of accident that leaves the backup as the only copy
 * left. Nothing in dsh 0.2 writes a `.bak-<stamp>` name, so this leg is best-effort by
 * nature — it costs a directory listing and finds the section when everything else has
 * been tidied away.
 * @param dshHome - the DSH home directory.
 * @returns candidate paths, in the order they should be consulted.
 */
export function legacyCandidates(dshHome) {
	const live = join(dshHome, "settings.yaml");
	const imported = join(dshHome, "settings.yaml.imported");
	let backups = [];
	try {
		backups = readdirSync(dshHome)
			.filter((name) => name.startsWith("settings.yaml.bak-"))
			.sort()
			.reverse()
			.map((name) => join(dshHome, name));
	} catch {
		backups = [];
	}
	return [live, imported, ...backups];
}

/**
 * The first candidate that actually carries the section.
 * @param candidates - paths to try.
 * @param pluginId - the section key.
 * @returns the document and the path it came from, or `undefined`.
 */
export function findLegacy(candidates, pluginId, yaml) {
	for (const path of candidates) {
		if (!existsSync(path)) continue;
		let document;
		try {
			document = yaml.parseDocument(readFileSync(path, "utf8"));
		} catch {
			continue;
		}
		const section = document.get(pluginId);
		if (section !== undefined && section !== null && typeof section === "object") {
			return { section: section.toJSON?.() ?? section, path };
		}
	}
	return undefined;
}

/** Options that may address the plugin row by either spelling. @param pluginId - the bare id. @returns the accepted row ids. */
function rowIds(pluginId) {
	return new Set([pluginId, `dsh-plugin-${pluginId}`]);
}

/**
 * The document node of the plugin's row, whether it is a top-level entry or inside
 * an `insert:` list. Both forms are in the wild: the installer writes the insert
 * form, and dsh's config editor writes the flat one.
 * @param document - the parsed patch.
 * @param pluginId - the plugin id.
 * @returns the row node, its parent list, and its index, or `undefined`.
 */
export function findRow(document, pluginId) {
	const accepted = rowIds(pluginId);
	const isRow = (node) => node !== null && typeof node?.get === "function" && accepted.has(node.get("id"));
	const search = (list) => {
		if (list === undefined || list === null || typeof list.items === "undefined") return undefined;
		for (let index = 0; index < list.items.length; index += 1) {
			const row = list.items[index];
			if (isRow(row)) return { row, list, index };
			const nested = row?.get?.("insert");
			if (nested !== undefined && nested !== null) {
				const found = search(nested);
				if (found !== undefined) return found;
			}
		}
		return undefined;
	};
	return search(document.contents);
}

/** Whether a row already carries settings the settings page could have written. @param row - the row node. @returns true when a non-empty config exists. */
export function hasConfig(row) {
	const config = row?.get?.("config");
	if (config === undefined || config === null) return false;
	const value = config.toJSON?.() ?? config;
	return value !== null && typeof value === "object" && Object.keys(value).length > 0;
}

/**
 * Migrate one profile.
 * @param options - resolved options.
 * @returns a process exit code, and for tests the document and paths involved.
 */
export async function migrate(options) {
	const profileDir = join(options.dshHome, "profiles", options.profile);
	const patchPath = join(profileDir, "cordis.patch.yml");
	if (!existsSync(patchPath)) return { code: NOTHING_TO_DO, reason: `no patch file at ${patchPath}` };

	const yaml = loadYaml(profileDir);
	if (yaml === undefined) {
		return { code: FAILED, reason: "could not load the `yaml` module, which this needs to read and rewrite the patch file" };
	}

	const keys = await acceptedKeys();
	let document;
	try {
		document = yaml.parseDocument(readFileSync(patchPath, "utf8"));
	} catch (error) {
		return { code: FAILED, reason: `${patchPath} is not readable YAML: ${error.message}` };
	}
	if (document.errors?.length > 0) return { code: FAILED, reason: `${patchPath} has a YAML error: ${document.errors[0].message}` };

	const found = findRow(document, options.pluginId);
	if (found === undefined) return { code: NOTHING_TO_DO, reason: `no "${options.pluginId}" row in ${patchPath}` };
	if (hasConfig(found.row)) {
		return { code: NOTHING_TO_DO, reason: `the "${options.pluginId}" row already carries settings; leaving them alone` };
	}

	const legacy = findLegacy(legacyCandidates(options.dshHome), options.pluginId, yaml);
	if (legacy === undefined) return { code: NOTHING_TO_DO, reason: "no legacy settings section to migrate" };

	const { config, dropped } = toRowConfig(legacy.section, keys);
	if (Object.keys(config).length === 0) {
		return { code: NOTHING_TO_DO, reason: `the legacy section in ${legacy.path} has no field this version still reads` };
	}

	found.row.set("config", document.createNode(config));
	const text = String(document);
	if (!options.dryRun) {
		try {
			writeFileSync(patchPath, text);
		} catch (error) {
			return { code: FAILED, reason: `could not write ${patchPath}: ${error.message}` };
		}
	}
	return { code: MIGRATED, path: patchPath, source: legacy.path, config, dropped, text, dryRun: options.dryRun === true, schemaStatus: keys.status };
}

const HELP = `Carry a 1.7.x settings section into the loader row this version reads.

  node scripts/migrate-legacy-settings.mjs --profile web [--dry-run]

  --dsh-home <dir>  DSH home (default: $DSH_HOME or ~/.dsh)
  --profile <name>  profile (default: $DSH_PROFILE or web)
  --plugin-id <id>  plugin id / legacy section key
  --dry-run         print the result instead of writing it
`;

// Run as a command when invoked as one, so the exports above stay importable.
//
// `--as-command` is how the installer says so outright. The name check is the fallback
// for a person running it by hand, and it deliberately matches on the basename: an
// equality test between `import.meta.url` and a URL built from `argv[1]` fails for the
// same path spelled two ways, and on macOS a temporary directory *is* two ways
// (`/var/...` is a symlink to `/private/var/...`), which silently turns the whole
// command into a no-op.
const invokedByName = process.argv[1] !== undefined && basename(process.argv[1]) === "migrate-legacy-settings.mjs";
if (invokedByName || process.argv.includes("--as-command")) {
	let options;
	try {
		options = readOptions(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`error: ${error.message}\n`);
		process.exit(FAILED);
	}
	if (options.help) {
		process.stdout.write(HELP);
		process.exit(MIGRATED);
	}
	const result = await migrate(options);
	if (result.code === MIGRATED) {
		process.stdout.write(`==> migrated your 1.7.x settings from ${result.source}\n`);
		if (result.dropped.length > 0) process.stdout.write(`    (dropped providers this version no longer knows: ${result.dropped.join(", ")})\n`);
		if (result.schemaStatus === "fallback") process.stdout.write("    (the plugin's own schema could not be imported; a copied field list was used)\n");
		if (result.dryRun) process.stdout.write(`${result.text}\n`);
	} else if (result.code === NOTHING_TO_DO) {
		process.stdout.write(`==> no settings to migrate: ${result.reason}\n`);
	} else {
		process.stderr.write(`error: ${result.reason}\n`);
	}
	process.exit(result.code);
}
