import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { Plugin } from 'vite'

/**
 * The X1 build check as a Vite plugin (qa-fixes ITEM-7; see
 * `scripts/check-built-css-urls.mjs` for the check itself).
 *
 * ITEM-6 (d): the plugin must check the directory the build ACTUALLY wrote.
 * The previous version hardcoded the config's default `dist` — a
 * `vite build --outDir somewhere-else` either failed spuriously when the
 * default dist did not exist, or — worse — verified a STALE dist while the
 * real output went unchecked. The plugin resolves the outDir the bundler
 * itself resolves (Vite's `path.resolve(root, outDir)` — the resolver it
 * uses to emit, seen at configResolved: `config.root` is the resolved root,
 * `config.build.outDir` the raw outDir, relative or absolute) and hands the
 * resolved directory to the script; the check is therefore part of the
 * build in both cases — the default outDir and an overridden one (the Tauri
 * desktop build goes through the same UI `npm run build`).
 *
 * Extracted from `vite.config.ts` so the behavioural test can drive the
 * plugin hooks against fixture dists without evaluating the whole config
 * (`__dirname` is Vite's inline-config shim; a direct import of the config
 * under node would not carry it).
 */

/** The check script (this module sits next to `vite.config.ts`). */
const CHECK_SCRIPT = fileURLToPath(new URL('./scripts/check-built-css-urls.mjs', import.meta.url))

export function txrBuiltCssUrlsCheck(): Plugin {
  let outDir = ''
  return {
    name: 'txr-built-css-urls-check',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      execFileSync(process.execPath, [CHECK_SCRIPT, outDir], {
        stdio: 'inherit',
      })
    },
  }
}
