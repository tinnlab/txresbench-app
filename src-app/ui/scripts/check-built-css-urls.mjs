#!/usr/bin/env node
/**
 * check-built-css-urls — the X1 build check (qa-fixes ITEM-7).
 *
 * Every `url()` in the BUILT CSS must resolve to a real file inside dist.
 * The defect it guards: `src/assets/fonts.css` declared its font urls as
 * `./assets/fonts/…` while the file already sits NEXT TO `src/assets/fonts/`,
 * so the path resolved to `src/assets/assets/fonts/…` and the built CSS
 * pointed at `/assets/assets/fonts/…` — a URL the dist does not contain (the
 * SPA index was served instead, and every font failed OTS parsing; the QA
 * report measured the tripled `/assets/assets/assets/fonts/…`). A stale base
 * in any future CSS edit now fails the build instead of shipping silent
 * fallback fonts.
 *
 * Usage: node scripts/check-built-css-urls.mjs [distDir]
 *   (default `src-app/ui/dist` — the Vite build's outDir).
 * Exit 0 = every url() in every built CSS file exists in dist.
 * Exit 1 = at least one url() does not (each missing target is printed).
 * External (http/https/data:) urls are outside the promise and are skipped.
 * Wired into the build: vite.config.ts runs it in `closeBundle` (the UI's
 * `npm run build` and the desktop's embedded build both go through Vite).
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_DIST = resolve(HERE, '..', 'dist')
const distRoot = resolve(process.argv[2] ?? DEFAULT_DIST)

if (!existsSync(distRoot) || !statSync(distRoot).isDirectory()) {
  console.error(`check-built-css-urls: dist not found at ${distRoot}`)
  process.exit(1)
}

/** Every css file under the dist root (the root css chunk + the lazy chunks). */
function cssFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...cssFiles(p))
    else if (entry.name.endsWith('.css')) out.push(p)
  }
  return out
}

/** All `url(...)` targets in a css file, in source order. */
function urlsOf(css) {
  const out = []
  const re = /url\(\s*(['"]?)([^)'"]+)\1\s*\)/g
  let m
  while ((m = re.exec(css)) !== null) out.push(m[2])
  return out
}

const missing = []
const checkedCss = cssFiles(distRoot)
if (checkedCss.length === 0) {
  console.error(`check-built-css-urls: no built css found under ${distRoot}`)
  process.exit(1)
}
for (const cssPath of checkedCss) {
  const css = readFileSync(cssPath, 'utf8')
  for (const raw of urlsOf(css)) {
    const url = raw.split(/[?#]/, 1)[0]
    if (url === '' || /^(data|https?|file|blob):/i.test(url) || url.startsWith('//')) continue
    // Absolute /assets/… resolves against the dist root; a relative url
    // resolves against the css file's own directory (Vite rewrites the font
    // urls to hashed /assets/… names near the css, but a relative form is
    // equally valid — check both spellings the same way).
    const target = url.startsWith('/')
      ? resolve(distRoot, `.${url}`)
      : resolve(dirname(cssPath), url)
    if (!existsSync(target)) missing.push({ css: cssPath, url, target })
  }
}

if (missing.length > 0) {
  console.error(`check-built-css-urls: ${missing.length} url() outside dist`)
  for (const m of missing) {
    console.error(`  ${m.url}  (in ${m.css.replace(distRoot + sep, '')})`)
  }
  process.exit(1)
}
console.log(
  `check-built-css-urls: OK — ${checkedCss.length} css files, every url() resolves inside dist`,
)
