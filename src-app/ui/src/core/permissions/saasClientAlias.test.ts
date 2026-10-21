// TEST-2 — acceptance test for the two-spec client seam (#50), INV-2.
//
// Pins the design invariant "nothing hardcodes isSaas; the desktop/default build does NOT reveal
// a saas permission". Proven against the REAL build-seam helper (`scripts/saas-client-alias.ts`,
// the single production caller from `vite.config.ts`): the default/desktop build (VITE_SAAS
// unset) produces NO alias to the saas client, so `@/api-client/permissions` stays the saas-OFF
// enum and billing::admin is absent; the hosted-web build (VITE_SAAS set) aliases the presence-
// gate enum client to api-client-saas. Flip the helper's behavior and this goes red.

import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { isSaasBuild, saasClientAlias } from '../../../scripts/saas-client-alias'

const SRC = '/repo/src-app/ui/src'

describe('saas client alias build-seam (#50, INV-2)', () => {
  it('desktop/default build (VITE_SAAS unset) does NOT alias to the saas client', () => {
    expect(isSaasBuild({})).toBe(false)
    expect(saasClientAlias(SRC, {})).toEqual([])
  })

  it('an explicit falsey VITE_SAAS is still treated as desktop (no alias)', () => {
    expect(isSaasBuild({ VITE_SAAS: '' })).toBe(false)
    expect(isSaasBuild({ VITE_SAAS: '0' })).toBe(false)
    expect(isSaasBuild({ VITE_SAAS: 'false' })).toBe(false)
    expect(saasClientAlias(SRC, { VITE_SAAS: '0' })).toEqual([])
  })

  it('hosted-web build (VITE_SAAS=1) aliases the presence-gate enum client to api-client-saas', () => {
    expect(isSaasBuild({ VITE_SAAS: '1' })).toBe(true)
    const aliases = saasClientAlias(SRC, { VITE_SAAS: '1' })
    const perm = aliases.find(a => a.find === '@/api-client/permissions')
    expect(perm).toBeTruthy()
    expect(perm!.replacement).toBe(path.resolve(SRC, 'api-client-saas/permissions'))
    // Never redirects endpoints/types — those come from the FIXED @/api-client-saas path.
    expect(aliases.find(a => a.find === '@/api-client/types')).toBeUndefined()
    expect(aliases.find(a => a.find === '@/api-client/apiEndpoints')).toBeUndefined()
  })

  it('VITE_SAAS=true is also accepted', () => {
    expect(isSaasBuild({ VITE_SAAS: 'true' })).toBe(true)
    expect(saasClientAlias(SRC, { VITE_SAAS: 'true' }).length).toBe(2)
  })
})
