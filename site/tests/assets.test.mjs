/**
 * assets.test.mjs — landing-site ITEM-5 suite, TEST-8: every font declared in
 * the stylesheet exists in the vendored font dir with its OFL licence; the
 * four board images and the favicon pair exist and are valid PNGs (an
 * orientation check: 1280x820 board PNGs, 512/32 px icons); the stylesheet
 * carries the design's flex-wrap layout and the narrow-viewport @media block
 * (the measured structural form of the 390px reflow — the pixel pass is the
 * owner-gated TEST-11 record).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SITE = join(ROOT, 'site');
const SRC = join(SITE, 'src');

function pngSize(p) {
  const b = readFileSync(p);
  assert.deepEqual([...b.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `PNG signature: ${p}`);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), bytes: b.length };
}

test('TEST-8 fonts, imagery, favicon, 390px reflow structure', () => {
  // every font the stylesheet declares exists under site/src/assets/fonts/
  const css = readFileSync(join(SRC, 'styles.css'), 'utf8');
  const families = new Set([...css.matchAll(/font-family:\s*'([^']+)'/g)].map((m) => m[1]));
  const fontFiles = [...css.matchAll(/url\(['"]?\.\/assets\/fonts\/([^'")]+)['"]?\)/g)].map((m) => m[1]);
  assert.ok(fontFiles.length >= 7, `seven vendored woff2 files declared (${fontFiles.length})`);
  const fontDir = join(SRC, 'assets', 'fonts');
  for (const f of fontFiles) {
    assert.ok(existsSync(join(fontDir, f)), `font file exists: assets/fonts/${f}`);
  }
  const actual = readdirSync(fontDir).filter((f) => f.endsWith('.woff2'));
  assert.ok(actual.length >= fontFiles.length, 'no font file is declared but missing');

  // each font family has its OFL licence next to the fonts (repo convention)
  const licences = readdirSync(fontDir).filter((f) => f.startsWith('LICENSE-OFL-'));
  for (const family of families) {
    const slug = family.replace(/\s+/g, '-');
    assert.ok(
      licences.some((l) => l.includes(slug)),
      `OFL licence present for family ${family}`,
    );
  }
  for (const family of ['Source Sans 3', 'Source Serif 4', 'Source Code Pro']) {
    assert.ok(families.has(family), `stylesheet declares ${family}`);
  }

  // the board imagery: the four approved PNGs, 1280x820, real bytes
  for (const name of ['results', 'files', 'methods', 'models']) {
    const p = join(SRC, 'assets', 'img', `${name}.png`);
    assert.ok(existsSync(p), `board image exists: img/${name}.png`);
    const dim = pngSize(p);
    assert.equal(dim.width, 1280, `${name}.png width`);
    assert.equal(dim.height, 820, `${name}.png height`);
    assert.ok(dim.bytes > 50_000, `${name}.png is a real image, not an empty stub`);
  }

  // favicon pair (ITEM-2 file list)
  const favicon = pngSize(join(SRC, 'assets', 'favicon.png'));
  assert.deepEqual([favicon.width, favicon.height], [512, 512], 'favicon.png is the 512px icon');
  const favicon32 = pngSize(join(SRC, 'assets', 'favicon-32x32.png'));
  assert.deepEqual([favicon32.width, favicon32.height], [32, 32], 'favicon-32x32.png is 32px');

  // 390px reflow: the design's flex-wrap layouts plus the narrow block
  assert.ok(/flex-wrap\s*:\s*wrap/.test(css), 'stylesheet carries the design flex-wrap layout');
  const media = /@media \(max-width:\s*640px\)\s*\{([\s\S]*)\}/.exec(css);
  assert.ok(media, 'narrow-viewport @media block present');
  assert.ok(/flex-wrap\s*:\s*wrap/.test(media[1]), 'media block keeps the flex-wrap layout');
  assert.ok(/\.tile\s*\{\s*flex-basis:\s*100%/.test(media[1]), 'one download tile per line at narrow widths');
  assert.ok(/\.hero-title\s*\{\s*font-size:\s*34px/.test(media[1]), '34px hero title at narrow widths');
});
