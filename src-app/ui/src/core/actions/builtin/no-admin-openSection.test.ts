import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Regression guards for the removal of the redundant admin-console landing hub
// (#42 shell) and its example `admin.openSection` action.
//
// TEST-3 [acceptance][invariant: INV-3] — the committed frontend-actions MCP
//   manifest no longer advertises `admin.openSection` (re-adding it, without or
//   with regen, turns this red).
// TEST-4 [covers: ITEM-5] — the action module and its sole import site are
//   actually gone from `src-app/ui/src`, so the comment cleanup reflects reality
//   and no dangling reference remains (the AI/human action surface can't reach a
//   deleted action).

const selfPath = fileURLToPath(import.meta.url)
const here = path.dirname(selfPath)
const manifestPath = path.resolve(
  here,
  '../../../../../server/src/modules/mcp/frontend-actions.json',
)
const uiSrc = path.resolve(here, '../../../') // src-app/ui/src

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      walkTsFiles(full, out)
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

describe('admin-console hub removal (#42)', () => {
  it('TEST-3: the frontend-actions manifest does not advertise admin.openSection', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const actions: Array<{ id: string }> = manifest.actions ?? manifest
    expect(Array.isArray(actions), 'manifest.actions must be an array').toBe(true)
    const ids = actions.map(a => a.id)
    expect(ids, 'admin.openSection must be absent from the MCP manifest').not.toContain(
      'admin.openSection',
    )
  })

  it('TEST-4: no src file imports builtin/adminActions and the action file is gone', () => {
    // The deleted example-action module must not exist.
    expect(
      existsSync(path.join(here, 'adminActions.ts')),
      'core/actions/builtin/adminActions.ts must be deleted',
    ).toBe(false)

    // No source file may import the deleted module or reference the removed
    // action id on a run/action surface. (`builtin/adminAccountActions` — a
    // different, RETAINED module — does not match the `builtin/adminActions`
    // substring, so it is not a false positive.)
    // Match REAL run-surface references only (import of the deleted module, or a
    // `runAction(...)` / `action=` reference to the removed id) — not a benign
    // mention of the id in a comment or design-doc citation. `builtin/adminAccountActions`
    // (a retained module) does not contain the `builtin/adminActions` substring.
    const runSurface =
      /builtin\/adminActions\b|runAction\(\s*['"]admin\.openSection['"]|action=['"]admin\.openSection['"]/
    const offenders: string[] = []
    for (const file of walkTsFiles(uiSrc)) {
      if (file === selfPath) continue // this guard file names the id on purpose
      if (runSurface.test(readFileSync(file, 'utf8'))) {
        offenders.push(path.relative(uiSrc, file))
      }
    }
    expect(offenders, `dangling admin.openSection / adminActions references: ${offenders}`).toEqual(
      [],
    )
  })
})
