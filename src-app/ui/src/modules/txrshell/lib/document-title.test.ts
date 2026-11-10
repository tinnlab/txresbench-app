import { describe, expect, it } from 'vitest'
import { APP_TITLE, documentTitleFor } from './document-title'

/**
 * TEST-QF2-3 (R2-G1) — the title bytes. The React hook itself is a thin
 * `useEffect` around `documentTitleFor`; the per-page wiring is pinned by
 * each module's own page test and by the full-backend spec that walks every
 * route and reads `document.title` under the real app. This suite pins the
 * one source of the suffix rule — "«subtitle» — TxResBench", the em dash —
 * and the empty-subtitle fallback, so no page can drift the format.
 */
describe('txrshell document-title (R2-G1)', () => {
  it('pins the app title', () => {
    expect(APP_TITLE).toBe('TxResBench')
  })

  it('renders "«subtitle» — TxResBench" with the board em dash', () => {
    expect(documentTitleFor('Help')).toBe('Help \u2014 TxResBench')
    expect(documentTitleFor('Predictions for 94 patients')).toBe(
      'Predictions for 94 patients \u2014 TxResBench',
    )
  })

  it('falls back to the plain app title for an empty subtitle', () => {
    expect(documentTitleFor('')).toBe('TxResBench')
    expect(documentTitleFor('   ')).toBe('TxResBench')
  })
})
