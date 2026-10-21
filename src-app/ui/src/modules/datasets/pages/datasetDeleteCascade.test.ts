// ITEM-42 — the integrated dataset in the datasets list, and what its deletion says.
//
// TWO claims, and they pull in opposite directions, which is why they are tested together:
//
//   1. The deletion confirmation must NAME what else goes (the `ON DELETE CASCADE` over
//      derived artifacts) rather than being a generic "are you sure".
//   2. NOTHING in this UI may branch on a dataset being integrated/virtual (INV-3). The
//      discriminant is a RECIPE the server reads (`structure.gathered_from`, DEC-8) and it
//      does not cross the data plane.
//
// A surface that satisfied (1) by adding a virtual-specific sentence would violate (2). The
// resolution is that the cascade sentence is TRUE OF BOTH and said once.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PAGE = fileURLToPath(new URL('./DatasetsLibraryPage.tsx', import.meta.url))
const source = readFileSync(PAGE, 'utf8')

/** The `description=` string literals the page passes to a `Confirm`, comments excluded.
 *
 *  Comments are stripped FIRST, and that is not incidental: this file's own explanatory
 *  comments name `gathered_from` and `virtual` while the CODE must not, and a reader that
 *  scanned raw text would fail on its own documentation. That exact mistake was made twice on
 *  this branch — a regex harvesting a comment explaining the fix, and a flag edited inside
 *  one — so the rule here is the one those cost: never assert against prose. */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map(line => line.replace(/(^|\s)\/\/.*$/, ''))
    .join('\n')
}

const code = codeOnly(source)

describe('the deletion confirmation NAMES the cascade', () => {
  it('is not a generic "are you sure" — it says what else is destroyed', () => {
    const desc = [...code.matchAll(/description="([^"]+)"/g)].map(m => m[1])
    // A filter matching nothing reports success having checked nothing.
    expect(desc.length, 'no Confirm description found — the reader has drifted').toBeGreaterThan(0)
    const cascade = desc.find(d => /permanently deletes/i.test(d))
    expect(cascade, 'the delete confirmation lost its description').toBeTruthy()
    // The named consequence. THIS is the assertion the plan's control targets: "use a generic
    // confirmation → the test finds no mention of the derived artifacts".
    expect(cascade, 'the prompt does not say derived work is destroyed').toMatch(
      /computed from it|derived/i,
    )
    // It must say the loss is UNIVERSAL — "every … in any project" — which is what separates
    // it from a prompt that only mentions this project's results. The earlier version asserted
    // three named examples; those were removed because naming them put domain nouns in a core
    // page, and the enumeration was illustrative rather than the claim (see the page).
    expect(cascade).toMatch(/every/i)
    expect(cascade).toMatch(/any project/i)
    // …and the reassurance that bounds it: an integrated dataset owns no source bytes, so its
    // sources survive. Without this the sentence over-warns and trains users to ignore it.
    expect(cascade).toMatch(/not affected|untouched/i)
  })

  it('claims no COUNT it cannot compute (the ITEM-39 rule, on a more destructive action)', () => {
    const desc = [...code.matchAll(/description="([^"]+)"/g)].map(m => m[1])
    const cascade = desc.find(d => /permanently deletes/i.test(d)) ?? ''
    // Every artifact route is project-scoped and this page is not, so no true count is
    // reachable here. A number in this sentence would therefore be fabricated — and a
    // fabricated count in front of a permanent delete reads as a safety clearance.
    expect(cascade, 'the cascade sentence states a number it cannot know').not.toMatch(/\d/)
  })
})

describe('INV-3 — nothing here branches on a dataset being integrated', () => {
  it('the page names no virtual/gathered discriminant in CODE', () => {
    // The recipe is the discriminant and it lives below the data plane (DEC-8). A client that
    // learned to recognise one would be the UI branch INV-3 forbids — and would also be keyed
    // on something the server deliberately does not send.
    for (const forbidden of [/\bgathered_from\b/, /\bstorage_kind\b/, /\bisVirtual\b/]) {
      expect(code, `the page branches on ${forbidden}`).not.toMatch(forbidden)
    }
  })

  it('the guard reads CODE, not comments — and this file proves the stripper works', () => {
    // A positive control for `codeOnly`, because the assertions above are the kind that pass
    // vacuously if the stripper eats everything. The page's own comments DO discuss
    // `gathered_from`; the raw source must contain it and the stripped code must not.
    expect(source, 'the page no longer explains why it does not branch').toMatch(/gathered_from/)
    expect(code).not.toMatch(/gathered_from/)
    // …and the stripper must not have eaten the code: the description it asserts on survives.
    expect(code).toMatch(/description="/)
  })
})
