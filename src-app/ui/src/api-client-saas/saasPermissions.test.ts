// TEST-2 [covers ITEM-2] — the collect-actions permission-union seam. A saas-only
// permission (billing::admin) is NOT in the default enum but IS in the saas enum,
// so a billing action can only validate if the collector unions both — which is
// exactly what makes the single committed manifest carry the AI-drivable billing
// actions. This locks (a) the necessity (the split) and (b) the union code.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd() // src-app/ui
const defaultEnum = readFileSync(resolve(root, 'src/api-client/permissions.ts'), 'utf8')
const saasEnum = readFileSync(resolve(root, 'src/api-client-saas/permissions.ts'), 'utf8')
const collector = readFileSync(resolve(root, 'scripts/collect-actions.mjs'), 'utf8')

describe('TEST-2 — saas permission-union seam', () => {
  it('billing::admin is a saas-only permission (present in saas, absent in default)', () => {
    expect(saasEnum).toContain("'billing::admin'")
    expect(defaultEnum).not.toContain("'billing::admin'")
    // admin::accounts (the suspend/reactivate permission) is in BOTH.
    expect(defaultEnum).toContain("'admin::accounts'")
    expect(saasEnum).toContain("'admin::accounts'")
  })

  it('collect-actions unions the saas permission enum into the known set', () => {
    expect(collector).toContain('api-client-saas')
    expect(collector).toContain('SAAS_PERMISSIONS_PATH')
    // The union is guarded by existsSync so a saas-less build stays default-only.
    expect(collector).toMatch(/existsSync\(SAAS_PERMISSIONS_PATH\)/)
  })
})
