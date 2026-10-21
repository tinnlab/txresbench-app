// @vitest-environment jsdom
//
// A SILENT TRUNCATION ON A MASKED FIELD IS THE ONE REWRITE THE USER CANNOT SEE.
//
// ── The defect ─────────────────────────────────────────────────────────────────────────────
// `ProfileSettingsPage` carried `maxLength={72}` on BOTH new-password fields. A 90-character
// passphrase pasted into a masked input is cut to 72 with no notice — and because the confirm
// field carries the SAME cap, the two truncated halves match, `refine` passes, the request
// succeeds and the page says "Password changed." Every signal the user has says the passphrase
// was taken as typed. They store the 90-character version and can never sign in again.
//
// This is worse than the clamps `clamp-notice.tsx` covers, and its remedy is different. That
// rule's third case (DISCARD → announce what was kept and what was dropped) does not apply to a
// credential: "kept 72 characters, dropped 18" would announce that the app chose a password the
// user did not. The only correct response to an over-length secret is to REFUSE it and say the
// limit — never to keep a prefix.
//
// ── The cap is real, but was mirrored in the wrong unit ────────────────────────────────────
// `ziee-auth`'s `validate_password_strength` REJECTS >72 (bcrypt's input limit), and Rust's
// `str::len()` is BYTES. `maxLength` counts UTF-16 code units. So the mirror was wrong twice:
// it truncated where the server refuses, and it counted characters where the server counts
// bytes — letting a 40-character emoji passphrase (160 bytes) through to a server rejection
// while cutting an 80-character ASCII one on the floor.
//
// ── The oracle ─────────────────────────────────────────────────────────────────────────────
// `typeInto` reads the cap OFF THE RENDERED ELEMENT and applies the HTML rule (`maxlength`
// constrains user edits; a programmatic `.value =` is exempt, which is why jsdom will not do
// this for us). It asserts on what the DOM would keep, not on a prop, and on what the submit
// handler is HANDED — not on the source text of the page.
//
// Nothing here prints or asserts a secret's characters: every assertion is a length, an
// equality against the input, or a refusal string.

import { act } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const changePassword =
  vi.fn(async (_patch: { current_password: string; new_password: string }) => {})

vi.mock('@/modules/auth/Auth.store', () => ({
  Auth: {
    user: {
      id: 'u1',
      username: 'ada',
      email: 'ada@x.test',
      display_name: 'Ada',
      is_admin: false,
      email_verified: true,
      created_at: '2026-01-01T00:00:00Z',
      last_login_at: null,
      avatar_url: null,
    },
    hasPassword: true,
    refreshCurrentUser: async () => {},
  },
}))

vi.mock('@/modules/profile/stores/Profile.store', () => ({
  Profile: {
    savingProfile: false,
    savingPassword: false,
    updateProfile: async () => {},
    changePassword,
  },
}))

vi.mock('@/core/permissions', () => ({
  usePermission: () => true,
  Can: ({ children }: { children?: React.ReactNode }) => children,
}))

const { ProfileSettingsPage } = await import('./ProfileSettingsPage')

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as never
  globalThis.matchMedia ??= ((q: string) => ({
    matches: false, media: q, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false },
  })) as never
  ;(Element.prototype as { getAnimations?: () => unknown[] }).getAnimations ??= () => []
  if (!globalThis.CSS) (globalThis as { CSS?: unknown }).CSS = { escape: (v: string) => v }
})

beforeEach(() => { changePassword.mockClear() })
afterEach(cleanup)

const byTestId = (id: string): HTMLInputElement => {
  const el = document.querySelector<HTMLInputElement>(`[data-testid="${id}"]`)
  if (!el) throw new Error(`no [data-testid="${id}"]`)
  return el
}

/**
 * Enter `text` the way a browser does, against the RENDERED element.
 *
 * HTML applies `maxlength` to user edits only — jsdom (correctly) does not enforce it on the
 * value setter, so a test that assigns `.value` directly would pass on the broken source. This
 * reads `el.maxLength` (−1 when the attribute is absent) off the live element and applies
 * exactly the browser's rule, then dispatches the native `input` event React listens for.
 *
 * Returns how many code units were DROPPED, which is the whole question.
 */
async function typeInto(el: HTMLInputElement, text: string): Promise<{ kept: number; dropped: number }> {
  const cap = el.maxLength
  const kept = cap >= 0 ? text.slice(0, cap) : text
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(el, kept)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  return { kept: kept.length, dropped: text.length - kept.length }
}

async function renderPage(): Promise<void> {
  await act(async () => { render(<ProfileSettingsPage />) })
}

async function submit(): Promise<void> {
  const form = document.querySelector<HTMLFormElement>('[data-testid="profile-password-form"]')
  if (!form) throw new Error('no password form')
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })
}

const errorText = (): string =>
  Array.from(document.querySelectorAll('[data-slot="field-error"], [role="alert"]'))
    .map(n => (n.textContent ?? '').replace(/\s+/g, ' ').trim())
    .join(' | ')

// A 90-unit passphrase. Never printed — only its length is ever asserted.
const LONG = 'correct-horse-battery-staple-and-then-some-more-words-to-push-us-well-past-seventy-two!!'.padEnd(90, 'x').slice(0, 90)

describe('the new-password field never keeps something other than what was entered', () => {
  it('drops nothing from a 90-unit passphrase', async () => {
    await renderPage()
    const outcome = await typeInto(byTestId('profile-new-password-input'), LONG)
    expect(outcome.dropped).toBe(0)
    expect(byTestId('profile-new-password-input').value.length).toBe(LONG.length)
  })

  it('drops nothing from the CONFIRM field either — the cap there is what hides the first', async () => {
    await renderPage()
    const outcome = await typeInto(byTestId('profile-confirm-password-input'), LONG)
    expect(outcome.dropped).toBe(0)
    expect(byTestId('profile-confirm-password-input').value.length).toBe(LONG.length)
  })

  it('submits the passphrase that was entered, or nothing at all — never a prefix of it', async () => {
    await renderPage()
    await typeInto(byTestId('profile-current-password-input'), 'currentPassw0rd!')
    await typeInto(byTestId('profile-new-password-input'), LONG)
    await typeInto(byTestId('profile-confirm-password-input'), LONG)
    await submit()

    // The page is free to REFUSE this passphrase (it is over the server's limit). What it may
    // never do is accept a shortened one: a submitted prefix is the credential the user will
    // never be able to reproduce.
    if (changePassword.mock.calls.length > 0) {
      const sent = changePassword.mock.calls[0][0].new_password
      expect(sent.length).toBe(LONG.length)
      expect(sent === LONG).toBe(true)
    }
  })

  it('over-length is REFUSED with a stated limit, and nothing is sent', async () => {
    await renderPage()
    await typeInto(byTestId('profile-current-password-input'), 'currentPassw0rd!')
    await typeInto(byTestId('profile-new-password-input'), LONG)
    await typeInto(byTestId('profile-confirm-password-input'), LONG)
    await submit()

    expect(changePassword).not.toHaveBeenCalled()
    expect(errorText()).toMatch(/72/)
  })

  it('the two fields cannot agree by both being cut the same way', async () => {
    // The 90-unit entry and a 73-unit entry are DIFFERENT passphrases. Under a shared 72-unit
    // cap both become the same 72 units and the mismatch check passes — the exact mechanism
    // that made the truncation invisible. Uncapped, they must disagree.
    await renderPage()
    await typeInto(byTestId('profile-current-password-input'), 'currentPassw0rd!')
    await typeInto(byTestId('profile-new-password-input'), LONG)
    await typeInto(byTestId('profile-confirm-password-input'), LONG.slice(0, 73))
    await submit()
    expect(errorText()).toMatch(/do not match/i)
    expect(changePassword).not.toHaveBeenCalled()
  })

  it('the limit is counted in BYTES, as the server counts it', async () => {
    // 30 emoji = 30 code points, 60 UTF-16 units, 120 UTF-8 bytes. A character cap would call
    // this fine and let the server reject it; a byte cap refuses it here, where it is fixable.
    await renderPage()
    const emoji = '🙂'.repeat(30)
    await typeInto(byTestId('profile-current-password-input'), 'currentPassw0rd!')
    await typeInto(byTestId('profile-new-password-input'), emoji)
    await typeInto(byTestId('profile-confirm-password-input'), emoji)
    await submit()
    expect(changePassword).not.toHaveBeenCalled()
    expect(errorText()).toMatch(/72/)
  })

  it('a multi-byte passphrase that FITS in 72 bytes is accepted', async () => {
    // 20 accented characters = 40 UTF-8 bytes: under the server's limit, so the client must not
    // invent a refusal. This is the negative control for the byte rule above.
    await renderPage()
    const accented = 'é'.repeat(20)
    await typeInto(byTestId('profile-current-password-input'), 'currentPassw0rd!')
    await typeInto(byTestId('profile-new-password-input'), accented)
    await typeInto(byTestId('profile-confirm-password-input'), accented)
    await submit()
    expect(changePassword).toHaveBeenCalledTimes(1)
    const sent = changePassword.mock.calls[0][0].new_password
    expect(sent.length).toBe(accented.length)
  })
})
