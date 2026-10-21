import { expect, test } from '@playwright/test'
import { loginAsOwner } from '../project/_helpers'

// P2 sniff (ITEM-13). The FE `sniffFile` helper POSTs a file to
// `/api/datatypes/sniff` so an upload picker pre-fills the detected type (the user
// never types a raw datatype id). Exercised end-to-end (real FE → real backend
// sniff) via the `window.__datatypeRegistry.sniffFile` seam.
//
// ── WHY THERE IS NOT A SINGLE DATATYPE ID LITERAL IN THIS FILE ──────────────
// This spec used to assert that a plain `.csv` sniffs to one specific table type.
// That type was PRUNED (it had no producing processor, and a generic `.csv` is not
// one particular kind of result table); the Rust twin `sniff.rs` was updated to
// assert `.csv -> None` in the SAME commit, and this file was not. Two enforcers of
// one behaviour, asserting opposite things, with nothing checking that they agree.
//
// So the expectation is now DERIVED at run time from the live registry the same
// server serves, never spelled out: whichever types declare an ingest hint for an
// extension are looked up, and the sniff answer is required to agree with them. Add
// or prune a type that claims `.csv` and this spec follows automatically — there is
// no literal left to go stale. `server/tests/datatype/cross_side_test.rs` enforces
// that property; it FAILS if an id literal is reintroduced here.

type Ingest = { extensions: string[]; magic_hex: string[] } | null
type Reg = {
  sniffFile: (f: File) => Promise<{ datatype: string | null; filename: string }>
  all: () => string[]
  ingestFor: (dt: string) => Ingest
}

test('a sniffed upload agrees with the ingest hints the registry ships — TEST-31', async ({
  page,
}) => {
  await loginAsOwner(page)
  // Wait for the AUTHORITATIVE populate, not merely the bootstrap skeleton: the
  // skeleton carries no ingest hints, so deriving from it would make every
  // expectation below vacuously "nothing claims this extension".
  await page.waitForFunction(
    () => {
      const r = (window as unknown as { __datatypeRegistry?: Reg }).__datatypeRegistry
      if (!r?.sniffFile) return false
      return r.all().some(id => (r.ingestFor(id)?.extensions.length ?? 0) > 0)
    },
    undefined,
    { timeout: 20_000 },
  )

  const out = await page.evaluate(async () => {
    const r = (window as unknown as { __datatypeRegistry: Reg }).__datatypeRegistry

    // Every type declaring an ingest hint — the ONLY types the sniffer can ever
    // return. Sorted, because the documented tie-break among equal matches is the
    // lowest datatype id.
    const sniffable = r.all().filter(id => r.ingestFor(id) !== null).sort()
    const claimants = (ext: string) =>
      sniffable.filter(id => r.ingestFor(id)!.extensions.some(e => e.toLowerCase() === ext))

    // An extension chosen to be claimed by nothing — and ASSERTED to be so below.
    // This is the "user uploads something we cannot type" control.
    const unclaimedExt = 'xyz'

    // A magic signature actually shipped by some type, decoded from that type's own
    // hex, so the magic-beats-extension rule is probed with real declared bytes.
    const magicOwner = sniffable.find(id => (r.ingestFor(id)!.magic_hex[0]?.length ?? 0) > 0)
    const magicHex = magicOwner ? r.ingestFor(magicOwner)!.magic_hex[0] : ''
    const magicBytes = new Uint8Array(
      (magicHex.match(/../g) ?? []).map(h => Number.parseInt(h, 16)),
    )

    const csvFile = new File(['a,b\n1,2'], 'results.csv', { type: 'text/csv' })
    const mystery = new File([new Uint8Array([0, 1, 2])], `mystery.${unclaimedExt}`)
    // The same unclaimed extension, but carrying a declared magic signature:
    // extension says "nothing", magic says "this type" — magic must win.
    const disguised = new File([magicBytes], `disguised.${unclaimedExt}`)

    return {
      sniffableCount: sniffable.length,
      csvClaimants: claimants('csv'),
      unclaimedClaimants: claimants(unclaimedExt),
      csv: await r.sniffFile(csvFile),
      mystery: await r.sniffFile(mystery),
      magic: await r.sniffFile(disguised),
      magicHex,
    }
  })

  // Non-vacuity floor: with no sniffable type at all, every derived expectation
  // below would hold trivially and this spec would be decoration.
  expect(out.sniffableCount).toBeGreaterThan(0)

  // ── the `.csv` behaviour, derived ────────────────────────────────────────
  // Whatever the shipped registry says about `.csv`, the sniff answer must agree
  // with it. Today nothing claims `.csv`, so the user sees "unknown" and picks the
  // type by hand; if a `.csv`-claiming type is ever contributed, the picker must
  // pre-fill it — and this same assertion covers that day with no edit.
  if (out.csvClaimants.length === 0) {
    expect(out.csv.datatype).toBeNull()
  } else {
    expect(out.csvClaimants).toContain(out.csv.datatype)
    // The documented deterministic tie-break: lowest id among equal matches.
    expect(out.csv.datatype).toBe(out.csvClaimants[0])
  }
  // The response echoes the upload regardless of whether it could be typed.
  expect(out.csv.filename).toBe('results.csv')

  // ── the unknown-file behaviour ───────────────────────────────────────────
  // The control is only a control if the extension really is unclaimed.
  expect(out.unclaimedClaimants).toEqual([])
  // null, not an error — the FE renders "unknown" and the upload still proceeds.
  expect(out.mystery.datatype).toBeNull()

  // ── magic beats extension ────────────────────────────────────────────────
  expect(out.magicHex.length).toBeGreaterThan(0)
  // That extension alone resolved to null just above; with a declared signature in
  // front of the very same extension, the sniffer must now type the file.
  expect(out.magic.datatype).not.toBeNull()

  // …and the type it picked must be one that actually declares that signature —
  // the property, rather than a hardcoded id.
  const declaresMagic = await page.evaluate(
    id =>
      (window as unknown as { __datatypeRegistry: Reg }).__datatypeRegistry.ingestFor(id)
        ?.magic_hex ?? [],
    out.magic.datatype as string,
  )
  expect(declaresMagic).toContain(out.magicHex)
})
