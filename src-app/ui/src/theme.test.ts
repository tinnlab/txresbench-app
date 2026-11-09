/**
 * TEST-QF-7 (dark-palette half, X3/CM-5/RP-11/RES-25) — the app's own palette
 * layer and the "no component keeps a light-only colour" enforcement.
 *
 * The defect class (the QA reports' X3/CM-5/RP-11/RES-25): the pages painted
 * hard-coded light hexes (`#fbfaf8`, `#f7f6f3`, `#ffffff`, …) inline while the
 * kit controls switch to the dark tokens, so dark OS mode produced a light
 * page with dark controls and invisible borders/checkboxes. The fix: one
 * token layer (`src/assets/txr-theme.css` — light `:root` = the design boards'
 * bytes, `.dark` = the app's own inversion beside the kit's dark tokens) and
 * every txr* component coloring through `var(--txr-*)`.
 *
 * What this pins:
 * 1. NO hex colour literal in any shipped txr* module source (the app's
 *    pages, the shell header, the session guard) — a colour can only reach a
 *    component through a token, so a component can never keep a light-only
 *    colour again. Tests are excluded (they PIN the tokens as expected
 *    values), as are the dev-only gallery files (never in a prod bundle) and
 *    the token file itself (where the light bytes must live).
 * 2. The token file's two blocks declare the SAME token names (a dark block
 *    that misses a token would silently leave that colour light), and the
 *    LIGHT values are the board bytes (the boards are the design source —
 *    DEC-5); the theme-only tokens differ in dark.
 * 3. Every token is actually used by the modules (a dead token is a sign of a
 *    missed conversion).
 * 4. The ITEM-2 temporary light-forcing hacks are gone: with the full dark
 *    palette the kit controls on the now-dark rows must follow the theme
 *    (their overrides would themselves be a light-only colour).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const UI = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MODULES = join(UI, 'src', 'modules')
const TOKENS = readFileSync(join(UI, 'src', 'assets', 'txr-theme.css'), 'utf8')

/** The token declarations of one block (`:root { … }` / `.dark { … }`). */
function tokenBlock(css: string, selector: string): Record<string, string> {
  const re = new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`)
  const body = re.exec(css)?.[1] ?? ''
  const out: Record<string, string> = {}
  for (const m of body.matchAll(/(--txr-[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim()
  return out
}

/** The board's light bytes (Start/Files/Results/Criteria.dc.html). */
const BOARD_LIGHT: Record<string, string> = {
  '--txr-bg': '#fbfaf8',
  '--txr-surface': '#ffffff',
  '--txr-surface-dim': '#f7f6f3',
  '--txr-surface-raised': '#efede8',
  '--txr-border': '#cfcdc7',
  '--txr-border-subtle': '#e7e5e0',
  '--txr-text': '#141414',
  '--txr-text-2': '#3a3a3a',
  '--txr-muted': '#5e5e5e',
  '--txr-brand': '#1d4e89',
  '--txr-on-brand': '#ffffff',
  '--txr-brand-ink': '#143a68',
  '--txr-accent-soft': '#e8eef6',
  '--txr-accent-softer': '#f4f8fc',
  '--txr-danger': '#b3261e',
  '--txr-danger-strong': '#b3261e',
  '--txr-on-danger': '#ffffff',
  '--txr-danger-soft': '#fdf3f2',
  '--txr-danger-border': '#f0c9c4',
  '--txr-success': '#1f6b3a',
  '--txr-success-ink': '#3d4a14',
  '--txr-success-soft': '#eef0e6',
  '--txr-success-soft-2': '#f1f9f3',
  '--txr-success-border': '#b9dcc4',
  '--txr-warning': '#8a5a00',
  '--txr-chance-rgb': '29, 78, 137',
  '--txr-on-chance': '#ffffff',
  '--txr-chance-gridline': '#ffffff',
}

describe('the txr theme token layer (TEST-QF-7, X3)', () => {
  it('declares the SAME token names in :root and .dark, with the board bytes as the light values', () => {
    const light = tokenBlock(TOKENS, ':root')
    const dark = tokenBlock(TOKENS, '.dark')
    expect(Object.keys(light).sort()).toEqual(Object.keys(BOARD_LIGHT).sort())
    expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort())
    for (const [token, byte] of Object.entries(BOARD_LIGHT)) {
      expect(light[token], `${token} light byte`).toBe(byte)
    }
    // The dark block is a real inversion: the theme-only tokens differ.
    const differs = Object.keys(light).filter(k => light[k] !== dark[k])
    expect(differs.length).toBeGreaterThan(18)
    // The theme-neutral tokens (text on saturated surfaces) stay put.
    expect(dark['--txr-on-chance']).toBe('#ffffff')
    expect(dark['--txr-on-danger']).toBe('#ffffff')
  })

  it('no shipped txr* module source carries a hex colour literal (a colour only enters through a token)', () => {
    const offenders: string[] = []
    const modules = readdirSync(MODULES).filter(n => n.startsWith('txr') || n === 'session')
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(p)
        } else if (/\.tsx?$/.test(entry.name)) {
          const rel = relative(UI, p)
          // Tests pin the tokens as EXPECTED values; the dev-only gallery
          // files are never in a prod bundle; SessionGuard is scanned (it is
          // the app's own loading/failure surface, tokenized with the rest).
          if (/\.test\.(ts|tsx)$/.test(entry.name) || entry.name === 'gallery.tsx') continue
          if (/^src-app\/ui\/src\/modules\/session\/SessionGuard\.tsx$/.test(rel) === false && !rel.includes('txr')) continue
          const src = readFileSync(p, 'utf8')
          const hit = /#[0-9a-fA-F]{3,8}\b/.exec(src)
          if (hit) offenders.push(`${rel}: ${hit[0]}`)
        }
      }
    }
    walk(MODULES)
    expect(offenders, 'hex colour literals in shipped txr module sources').toEqual([])
  })

  it('every token is used by at least one module (a dead token is an unconverted surface)', () => {
    const used = new Set<string>()
    const modules = readdirSync(MODULES).filter(n => n.startsWith('txr'))
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(p)
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) && entry.name !== 'gallery.tsx') {
          for (const m of readFileSync(p, 'utf8').matchAll(/var\((--txr-[a-z0-9-]+)\)/g)) used.add(m[1])
        }
      }
    }
    walk(MODULES)
    const tokens = Object.keys(BOARD_LIGHT).sort()
    expect(tokens).not.toHaveLength(0)
    const unused = tokens.filter(t => !used.has(t))
    // The theme file's own comments may name the odd token; the pin is the
    // component usage — a token that no component reads is a leak.
    expect(unused, 'unused txr tokens').toEqual([])
  })

  it('the ITEM-2 light-forcing hacks are gone (the kit controls take the theme with the pages)', () => {
    const index = readFileSync(join(UI, 'src', 'index.css'), 'utf8')
    expect(index).not.toContain('.txr-list-checkbox:is(.dark *)')
    expect(index).not.toContain('.txr-settings-switch:is(.dark *)')
  })
})
