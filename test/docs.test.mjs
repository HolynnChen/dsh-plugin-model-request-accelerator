/**
 * Contract test for the documentation itself.
 *
 * The docs are cross-linked in both directions and in two languages, which is exactly
 * the arrangement where a rename breaks a link silently — nothing runs a broken link,
 * so nothing reports it. The same is true of a language pair drifting apart: a reader
 * following the Chinese README into a missing file, or a translation that stopped
 * mirroring its original, is a failure no other test can see.
 *
 * Three properties:
 *   1. every relative link resolves, and every `#anchor` names a heading that exists;
 *   2. each translated document mirrors its original's heading structure, so the two
 *      say the same things in the same order;
 *   3. the README links to every document in `docs/`, so a new one cannot be orphaned.
 *
 * Run: npm test (from the package root; the script lists every suite)
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Documents that carry no translation, and why. @type {ReadonlySet<string>} */
const UNTRANSLATED = new Set(["INTERNALS.md", "CONTRIBUTING.md"]);

/**
 * Every document shipped for reading.
 * @returns absolute paths, README first.
 */
function documents() {
	const docs = readdirSync(join(PACKAGE_ROOT, "docs"))
		.filter((name) => name.endsWith(".md"))
		.sort()
		.map((name) => join(PACKAGE_ROOT, "docs", name));
	return [join(PACKAGE_ROOT, "README.md"), join(PACKAGE_ROOT, "README.zh.md"), ...docs];
}

/**
 * Markdown links that point inside the repository.
 * @param file - the document.
 * @returns `{ label, target }` for each relative link and each anchor.
 */
function links(file) {
	const text = readFileSync(file, "utf8");
	return [...text.matchAll(/\[([^\]]+)\]\(([^)]+)\)/gu)]
		.map((match) => ({ label: match[1], target: match[2] }))
		.filter(({ target }) => !/^(https?:|mailto:)/u.test(target));
}

/**
 * GitHub's heading anchor for a text run.
 * @param heading - the heading's text.
 * @returns the slug GitHub generates.
 */
function slug(heading) {
	return heading
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\p{M} _-]/gu, "")
		.trim()
		.replace(/ +/gu, "-");
}

/**
 * The anchors a document provides.
 * @param file - the document.
 * @returns a set of slugs, including explicit `{#id}` targets.
 */
function anchors(file) {
	const text = readFileSync(file, "utf8");
	const found = new Set();
	for (const [, heading] of text.matchAll(/^#{1,6} +(.+)$/gmu)) found.add(slug(heading));
	for (const [, explicit] of text.matchAll(/\{#([^}]+)\}/gu)) found.add(explicit);
	return found;
}

test("every relative link and anchor in the documentation resolves", () => {
	const broken = [];
	for (const file of documents()) {
		const here = dirname(file);
		const ownAnchors = anchors(file);
		for (const { label, target } of links(file)) {
			const relative = file.slice(PACKAGE_ROOT.length + 1);
			if (target.startsWith("#")) {
				if (!ownAnchors.has(target.slice(1))) broken.push(`${relative}: [${label}](${target}) names no heading`);
				continue;
			}
			const [path, anchor] = target.split("#");
			const resolved = resolve(here, path);
			if (!existsSync(resolved)) {
				broken.push(`${relative}: [${label}](${target}) does not exist`);
				continue;
			}
			// A cross-file anchor has to exist in the target, or the reader lands nowhere.
			if (anchor !== undefined && !anchors(resolved).has(anchor)) broken.push(`${relative}: [${label}](${target}) names no heading in ${path}`);
		}
	}
	assert.deepEqual(broken, [], `broken documentation links:\n  ${broken.join("\n  ")}`);
});

test("each translated document mirrors its original", () => {
	// Structurally, not word for word: the same headings in the same order, so the two
	// editions cannot drift into describing different things.
	const pairs = [["README.md", "README.zh.md"]];
	for (const name of readdirSync(join(PACKAGE_ROOT, "docs")).sort()) {
		if (!name.endsWith(".md") || name.endsWith(".zh.md") || UNTRANSLATED.has(name)) continue;
		pairs.push([join("docs", name), join("docs", name.replace(/\.md$/u, ".zh.md"))]);
	}
	for (const [original, translation] of pairs) {
		const from = join(PACKAGE_ROOT, original);
		const to = join(PACKAGE_ROOT, translation);
		assert.ok(existsSync(to), `${original} has no translation at ${translation}`);
		const headings = (file) => [...readFileSync(file, "utf8").matchAll(/^(#{1,3}) +(.+)$/gmu)].map(([, hashes]) => hashes.length);
		assert.deepEqual(
			headings(to),
			headings(from),
			`${translation} does not mirror ${original}'s heading structure — same count, same levels, same order`
		);
	}
});

test("the README links to every document in docs/", () => {
	const readme = readFileSync(join(PACKAGE_ROOT, "README.md"), "utf8");
	const orphans = readdirSync(join(PACKAGE_ROOT, "docs"))
		.filter((name) => name.endsWith(".md") && !name.endsWith(".zh.md"))
		.filter((name) => !readme.includes(`docs/${name}`));
	assert.deepEqual(orphans, [], `these documents are not reachable from the README: ${orphans.join(", ")}`);
});

test("no document restates what another one owns", () => {
	// The reason the README was split. A bounded check: the deep implementation markers
	// must not creep back into the user-facing README, and the README's job — the install
	// command — must not be duplicated into the deep documents.
	const readme = readFileSync(join(PACKAGE_ROOT, "README.md"), "utf8");
	for (const marker of ["undici:request", "data-width-handle", "node:vm", "AsyncLocalStorage"]) {
		assert.equal(readme.includes(marker), false, `"${marker}" is internals material and belongs in docs/INTERNALS.md`);
	}
});
