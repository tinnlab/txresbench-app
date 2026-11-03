/**
 * hygiene.test.mjs — landing-site ITEM-5 suite, TEST-7 (INV-2): the
 * published-content set carries no status/progress/placeholder vocabulary.
 *
 * Scope (TESTS.md TEST-7): site/src/**, site/config.json, site/README.md
 * (when it exists — the runbook is ITEM-6). The scan deliberately excludes
 * site/tests/** (which must NAME the patterns it polices) and
 * scripts/build-landing-site.mjs (which must NAME the fields it checks).
 * Binary assets (fonts) are excluded by extension: the scan is a text scan;
 * the woff2 files are compressed binary.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SITE = join(ROOT, 'site');

// case-sensitive for the marked-up abbreviations, case-insensitive for the
// prose phrases (a capitalized "Draft" would be the same marker).
const MARKERS = [
  /\bTODO\b/,
  /\bTBD\b/,
  /\bFIXME\b/,
  /\bXXX\b/,
  /coming soon/i,
  /under construction/i,
  /design example/i,
  /placeholder/i,
  /draft/i,
  /pending/i,
];
const TEXT_EXTENSIONS = new Set(['.html', '.css', '.json', '.md', '.txt']);

function publishable(root) {
  const files = [];
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    if (statSync(p).isDirectory()) files.push(...publishable(p));
    else files.push(p);
  }
  return files;
}

test('TEST-7 published content carries no status / progress / placeholder markers', () => {
  const scope = [];
  for (const f of publishable(join(SITE, 'src'))) scope.push(f);
  scope.push(join(SITE, 'config.json'));
  const readme = join(SITE, 'README.md');
  if (existsSync(readme)) scope.push(readme);

  const hits = [];
  for (const p of scope) {
    if (!TEXT_EXTENSIONS.has(p.slice(p.lastIndexOf('.')))) continue;
    const text = readFileSync(p, 'utf8');
    for (const re of MARKERS) {
      const m = re.exec(text);
      if (m) hits.push(`${p}: ${m[0]}`);
    }
  }
  assert.deepEqual(hits, [], `published content carries a status marker: ${hits.join(', ')}`);
});
