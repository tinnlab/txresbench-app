// @vitest-environment jsdom
//
// EVERY FORM THAT CHOOSES A NEW PASSWORD ENFORCES THE SERVER'S BAND — IN THE SERVER'S UNIT.
//
// ── The inverse of the truncation defect ───────────────────────────────────────────────────
// `ProfileSettingsPage` had a cap the server does not have (it truncated where the server
// refuses). These three forms had the opposite gap: NO upper bound at all, and a lower bound of
// SIX where the server's is EIGHT. So a user typing a 6-character password on the sign-up form
// was told it was fine, submitted, and got the server's WEAK_PASSWORD back with no field to
// blame it on — and a 90-character one was accepted here and rejected there.
//
// Both halves are the same mistake: a client-side mirror that does not match what the server
// actually enforces. `core/passwordPolicy` is the single mirror; this file is what stops these
// call sites from quietly drifting off it again, because nothing else would notice — the policy's
// own unit tests pass whether or not any form imports it.
//
// ── The oracle ─────────────────────────────────────────────────────────────────────────────
// Each form is RENDERED and driven through its real submit path. The assertions are on whether
// the store action was called and on the refusal text in the document — never on a schema object,
// and never on a secret's characters.

import { act } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const createUser = vi.fn(async (_d: { password: string }) => ({ id: 'u9' }))
const resetUserPassword = vi.fn(async (_id: string, _pw: string) => {})
const registerNewUser = vi.fn(async (_d: { password: string }) => {})

vi.mock('@/modules/user/stores/Users.store', () => ({
  Users: { creating: false, resetting: false, createUser, resetUserPassword },
}))
vi.mock('@/modules/user/components/user/CreateUserDrawer.store', () => ({
  CreateUserDrawer: { isOpen: true, openCreateUserDrawer: () => {}, closeCreateUserDrawer: () => {} },
}))
vi.mock('@/modules/user/components/user/ResetPasswordDrawer.store', () => ({
  ResetPasswordDrawer: {
    isOpen: true,
    user: { id: 'u1', username: 'ada' },
    openResetPasswordDrawer: () => {},
    closeResetPasswordDrawer: () => {},
  },
}))
vi.mock('@/modules/auth/Auth.store', () => ({
  Auth: {
    isLoading: false,
    error: null,
    registerNewUser,
    clearAuthenticationError: () => {},
  },
}))
vi.mock('@/core/permissions', () => ({
  usePermission: () => true,
  Can: ({ children }: { children?: React.ReactNode }) => children,
}))
vi.mock('react-router-dom', () => ({ useNavigate: () => () => {} }))
vi.mock('@/modules/user/components/PermissionsField.tsx', () => ({
  PermissionsField: () => null,
}))

// Register the Users identity-CRUD actions (#49): the drawers now dispatch their mutations
// via `runAction('user.create'/'user.resetPassword', …)`, whose `run` calls the SAME (here
// mocked) Users store method. Without this the action is unregistered and runAction throws.
await import('@/core/actions/builtin/usersAdminActions')
const { CreateUserDrawer } = await import('./CreateUserDrawer')
const { ResetPasswordDrawer } = await import('./ResetPasswordDrawer')
const { RegisterForm } = await import('@/modules/auth/RegisterForm')

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

beforeEach(() => {
  createUser.mockClear()
  resetUserPassword.mockClear()
  registerNewUser.mockClear()
})
afterEach(cleanup)

const byTestId = (id: string): HTMLInputElement => {
  const el = document.querySelector<HTMLInputElement>(`[data-testid="${id}"]`)
  if (!el) throw new Error(`no [data-testid="${id}"]`)
  return el
}

/** Enter `text` the way a browser does — honouring any cap the RENDERED element declares. */
async function typeInto(el: HTMLInputElement, text: string): Promise<void> {
  const cap = el.maxLength
  const kept = cap >= 0 ? text.slice(0, cap) : text
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(el, kept)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function submitForm(name: string): Promise<void> {
  const form = document.querySelector<HTMLFormElement>(`form[name="${name}"]`)
    ?? document.querySelector<HTMLFormElement>('form')
  if (!form) throw new Error(`no form ${name}`)
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })
}

const errorText = (): string =>
  Array.from(document.querySelectorAll('[data-slot="field-error"], [role="alert"]'))
    .map(n => (n.textContent ?? '').replace(/\s+/g, ' ').trim())
    .join(' | ')

/** 7 bytes: under the server's floor of 8, over the old client floor of 6. */
const SEVEN = 'abcdefg'
/** 73 bytes: one past the server's ceiling, which these forms did not have at all. */
const OVER = 'a'.repeat(73)
/** Comfortably inside the band — the negative control for every refusal below. */
const OK = 'aPassphraseThatFits'

describe('CreateUserDrawer', () => {
  const fill = async (pw: string) => {
    await act(async () => { render(<CreateUserDrawer />) })
    await typeInto(byTestId('user-create-username-input'), 'ada')
    await typeInto(byTestId('user-create-email-input'), 'ada@x.test')
    await typeInto(byTestId('user-create-password-input'), pw)
    await submitForm('create-user')
  }

  it('refuses 7 bytes — the old 6-character floor let the server say no instead', async () => {
    await fill(SEVEN)
    expect(createUser).not.toHaveBeenCalled()
    expect(errorText()).toMatch(/8/)
  })

  it('refuses 73 bytes — there was no upper bound here at all', async () => {
    await fill(OVER)
    expect(createUser).not.toHaveBeenCalled()
    expect(errorText()).toMatch(/72/)
  })

  it('accepts a password inside the band, unchanged', async () => {
    await fill(OK)
    expect(createUser).toHaveBeenCalledTimes(1)
    expect(createUser.mock.calls[0][0].password.length).toBe(OK.length)
  })

  it('declares no cap on the masked field', async () => {
    await act(async () => { render(<CreateUserDrawer />) })
    expect(byTestId('user-create-password-input').maxLength).toBe(-1)
  })
})

describe('ResetPasswordDrawer', () => {
  const fill = async (pw: string) => {
    await act(async () => { render(<ResetPasswordDrawer />) })
    await typeInto(byTestId('user-reset-new-password-input'), pw)
    await typeInto(byTestId('user-reset-confirm-password-input'), pw)
    await submitForm('reset-password-form')
  }

  it('refuses 7 bytes', async () => {
    await fill(SEVEN)
    expect(resetUserPassword).not.toHaveBeenCalled()
    expect(errorText()).toMatch(/8/)
  })

  it('refuses 73 bytes', async () => {
    await fill(OVER)
    expect(resetUserPassword).not.toHaveBeenCalled()
    expect(errorText()).toMatch(/72/)
  })

  it('accepts a password inside the band, unchanged', async () => {
    await fill(OK)
    expect(resetUserPassword).toHaveBeenCalledTimes(1)
    expect(resetUserPassword.mock.calls[0][1].length).toBe(OK.length)
  })

  it('declares no cap on either masked field', async () => {
    await act(async () => { render(<ResetPasswordDrawer />) })
    expect(byTestId('user-reset-new-password-input').maxLength).toBe(-1)
    expect(byTestId('user-reset-confirm-password-input').maxLength).toBe(-1)
  })
})

describe('RegisterForm', () => {
  const fill = async (pw: string) => {
    await act(async () => { render(<RegisterForm />) })
    await typeInto(byTestId('auth-register-username'), 'ada')
    await typeInto(byTestId('auth-register-email'), 'ada@x.test')
    await typeInto(byTestId('auth-register-password'), pw)
    await typeInto(byTestId('auth-register-confirm-password'), pw)
    await submitForm('register')
  }

  it('refuses 7 bytes', async () => {
    await fill(SEVEN)
    expect(registerNewUser).not.toHaveBeenCalled()
    expect(errorText()).toMatch(/8/)
  })

  it('refuses 73 bytes', async () => {
    await fill(OVER)
    expect(registerNewUser).not.toHaveBeenCalled()
    expect(errorText()).toMatch(/72/)
  })

  it('accepts a password inside the band, unchanged', async () => {
    await fill(OK)
    expect(registerNewUser).toHaveBeenCalledTimes(1)
    expect(registerNewUser.mock.calls[0][0].password.length).toBe(OK.length)
  })

  it('declares no cap on either masked field', async () => {
    await act(async () => { render(<RegisterForm />) })
    expect(byTestId('auth-register-password').maxLength).toBe(-1)
    expect(byTestId('auth-register-confirm-password').maxLength).toBe(-1)
  })
})
