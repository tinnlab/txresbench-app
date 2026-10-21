import { describe, it, expect } from 'vitest'
import { producerTargets, type ProducerCandidate } from './producerTargets'

// DEC-6: the guidance text is AUTHORED, the destination is DERIVED. These pin the derivation —
// the half a view author never writes, and therefore the half that must not need editing when a
// deployment ships a different producer.

const CONSUMER: ProducerCandidate = { id: 'consumer', title: 'Consumer', consumes: ['col'] }
const PRODUCER: ProducerCandidate = { id: 'producer', title: 'Producer', produces: ['col'] }

describe('a consumer’s guidance points at whatever produces what it consumes', () => {
  it('finds the producer, and labels it with ITS OWN title', () => {
    // The label comes from the target, never from the consumer: a consumer that wrote the label
    // goes stale exactly as a hardcoded id does.
    expect(producerTargets('consumer', [CONSUMER, PRODUCER])).toEqual([
      { id: 'producer', title: 'Producer' },
    ])
  })

  it('is derived — a DIFFERENT producer of the same type is found with no edit anywhere', () => {
    // The invariant, not the example. A fixture analysis declaring `produces: [<type>]` becomes
    // the target for any view consuming it, with zero app or view changes.
    const other: ProducerCandidate = { id: 'other.pkg', title: 'Other', produces: ['col'] }
    expect(producerTargets('consumer', [CONSUMER, other]).map(t => t.id)).toEqual(['other.pkg'])
  })

  it('offers ALL producers when there are several, and picks none', () => {
    // Choosing for the user is the "only one match, selected automatically" mistake that once
    // bound a picker to identifier columns (DEC-7).
    const second: ProducerCandidate = { id: 'p2', title: 'Second', produces: ['col'] }
    expect(producerTargets('consumer', [CONSUMER, PRODUCER, second]).map(t => t.id).sort()).toEqual([
      'p2',
      'producer',
    ])
  })

  it('finds nothing when nothing produces the type — a dead link is worse than none', () => {
    const unrelated: ProducerCandidate = { id: 'u', title: 'U', produces: ['something-else'] }
    expect(producerTargets('consumer', [CONSUMER, unrelated])).toEqual([])
  })

  it('never offers the consumer itself', () => {
    // An analysis that produced what it consumed would offer to launch itself as the remedy for
    // its own empty state.
    const selfish: ProducerCandidate = { id: 'consumer', consumes: ['col'], produces: ['col'] }
    expect(producerTargets('consumer', [selfish])).toEqual([])
  })

  it('finds nothing for an analysis that consumes nothing, or is unknown', () => {
    expect(producerTargets('nobody', [CONSUMER, PRODUCER])).toEqual([])
    expect(producerTargets('p', [{ id: 'p', produces: ['col'] }])).toEqual([])
  })

  it('falls back to the id when a producer declares no title', () => {
    // An affordance labelled `undefined` is worse than one labelled with a raw id.
    expect(producerTargets('consumer', [CONSUMER, { id: 'bare', produces: ['col'] }])).toEqual([
      { id: 'bare', title: 'bare' },
    ])
  })
})
