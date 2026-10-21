import { expect, test } from '@playwright/test'
import { loginAsOwner } from './helpers'

// TEST-16: a user WITH `mcp::use` sees the "AI Assistant Access" settings
// entry, opens /settings/ai-access, clicks Connect → `POST /api/mcp/pair/start`
// is called and the pairing code + server URL render (CONTRACT.md `pair/start`
// → `{ code, mcp_url }`; PLAN.md ITEM-17/18/19). The owner (first-run admin)
// holds every permission including `mcp::use`, so it doubles as the
// "WITH mcp::use" principal.

test('a user with mcp::use connects via the AI Assistant Access settings page', async ({
  page,
}) => {
  await loginAsOwner(page)

  // Land on a settings page that renders the full nav, and see the entry.
  // (The kit `Menu` renders each settings-section item as a `<button>`, not
  // an `<a>` — confirmed against the real DOM, not assumed.)
  await page.goto('/settings/general')
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  const navEntry = page.getByTestId('settings-nav-menu').getByRole('button', {
    name: 'AI Assistant Access',
    exact: true,
  })
  await expect(navEntry).toBeVisible()

  await navEntry.click()
  await expect(page).toHaveURL(/\/settings\/ai-access$/)
  await expect(page.getByTestId('ai-access-page')).toBeVisible()
  await expect(page.getByTestId('ai-access-connect-card')).toBeVisible()

  // Nothing paired yet — the connect button is the only affordance.
  const connectButton = page.getByTestId('ai-access-connect-start')
  await expect(connectButton).toBeVisible()
  await expect(page.getByTestId('ai-access-mcp-url')).toHaveCount(0)

  const pairStart = page.waitForResponse(
    r => r.url().includes('/api/mcp/pair/start') && r.request().method() === 'POST',
  )
  await connectButton.click()
  const resp = await pairStart
  expect(resp.ok(), `pair/start -> ${resp.status()}`).toBeTruthy()
  const body = await resp.json()
  expect(body.code, 'pair/start must return a pairing code').toBeTruthy()
  expect(body.mcp_url, 'pair/start must return an mcp_url').toBeTruthy()

  // The pairing code + server URL render from that exact response.
  await expect(page.getByTestId('ai-access-mcp-url')).toHaveValue(body.mcp_url)
  await expect(page.getByTestId('ai-access-mcp-code')).toHaveValue(body.code)
  await expect(page.getByTestId('ai-access-instructions')).toBeVisible()
})
