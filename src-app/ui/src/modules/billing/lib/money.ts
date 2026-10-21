// Money formatting for the Billing Console.
//
// Every money value in the billing API is an INTEGER number of CENTS
// (`amount_cents`, `balance_cents`, `spend_cap_cents`) — see
// `docs/design/admin-credits-override.md` ("Credits are in CENTS"). The UI renders
// dollars everywhere (INV-5): NEVER a raw cents integer where a dollar amount
// belongs. This is the single source of that conversion.

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/** Format integer cents as a USD dollar string, e.g. `formatCents(1250) → "$12.50"`. */
export function formatCents(cents: number): string {
  // Guard against a NaN/undefined slipping through to "$NaN".
  const n = Number.isFinite(cents) ? cents : 0
  return USD.format(n / 100)
}

/** Convert a dollar amount (from a form field) to integer cents, e.g.
 *  `dollarsToCents(12.5) → 1250`. Rounds to the nearest cent to avoid binary
 *  float drift (`12.10 * 100 → 1209.9999…`). */
export function dollarsToCents(dollars: number): number {
  if (!Number.isFinite(dollars)) return 0
  return Math.round(dollars * 100)
}
