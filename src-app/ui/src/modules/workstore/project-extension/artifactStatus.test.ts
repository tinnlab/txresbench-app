import { describe, expect, it } from 'vitest'
import {
  describeArtifactStatus,
  isKnownArtifactStatus,
  KNOWN_ARTIFACT_STATUSES,
} from './artifactStatus'

// ITEM-41 — the status vocabulary.
//
// The assertion that carries the weight is NOT "each status has a label". It is that
// `failed` and `unresolvable` are told APART, in every channel a user reads: the tone,
// the label, and above all the remedy. They are the two states that both mean "you
// cannot read this" and that need OPPOSITE actions, and a UI that blurs them offers to
// delete work that is perfectly good.

describe('failed vs unresolvable — the distinction that must never collapse', () => {
  const failed = describeArtifactStatus('failed')
  const unresolvable = describeArtifactStatus('unresolvable')

  it('is a real distinction in every channel, not just a different word', () => {
    expect(failed.label).not.toBe(unresolvable.label)
    expect(failed.tone).not.toBe(unresolvable.tone)
    expect(failed.remedy).not.toBe(unresolvable.remedy)
    // Both unusable — the distinction is about the REMEDY, not about readability.
    expect(failed.usable).toBe(false)
    expect(unresolvable.usable).toBe(false)
  })

  it('tells the user to delete/re-run ONLY for failed', () => {
    expect(failed.remedy).toMatch(/delete|re-run/i)
  })

  // The load-bearing one. `unresolvable` means the artifact is INTACT and its source is
  // gone; deleting it destroys good work and does not fix anything. If a future edit
  // reuses `failed`'s copy here — the obvious way to "simplify" two near-identical
  // states — this goes red.
  it('NEVER tells the user to delete an unresolvable artifact, and names the real fix', () => {
    expect(unresolvable.remedy).toMatch(/restore|re-attach/i)
    expect(unresolvable.remedy).not.toMatch(/\bdelete (it|this)\b/i)
    expect(unresolvable.remedy).toMatch(/deleting this will not fix it/i)
  })

  // Tone is the channel a user reads BEFORE any words. Destructive red on an intact
  // artifact is the visual half of the same conflation.
  it('does not paint an intact artifact in the destructive tone', () => {
    expect(failed.tone).toBe('error')
    expect(unresolvable.tone).not.toBe('error')
  })
})

describe('the vocabulary is exhaustive over what the server can send', () => {
  it('covers exactly the four server values', () => {
    expect([...KNOWN_ARTIFACT_STATUSES].sort()).toEqual(
      ['failed', 'pending', 'ready', 'unresolvable'].sort(),
    )
  })

  it('marks only `ready` usable — a state nobody decided about is not a privilege', () => {
    for (const s of KNOWN_ARTIFACT_STATUSES) {
      expect(describeArtifactStatus(s).usable).toBe(s === 'ready')
    }
  })

  it('recognises every known value and nothing else', () => {
    for (const s of KNOWN_ARTIFACT_STATUSES) expect(isKnownArtifactStatus(s)).toBe(true)
    expect(isKnownArtifactStatus('quarantined')).toBe(false)
    expect(isKnownArtifactStatus('')).toBe(false)
  })
})

describe('the unrecognised fallback is LOUD, not neutral', () => {
  // The class being closed: a server that grows a FIFTH status while an older client
  // renders it as an unremarkable grey word — the same bug as this item, one version on.
  it('flags an unknown value, refuses to call it usable, and says what to do', () => {
    const d = describeArtifactStatus('quarantined')
    expect(d.unrecognised).toBe(true)
    expect(d.usable).toBe(false)
    expect(d.tone).not.toBe('default')
    expect(d.remedy).not.toBe('')
    expect(d.remedy).toMatch(/does not recognise/i)
  })

  it('does not mark a KNOWN value unrecognised (the control for the assertion above)', () => {
    for (const s of KNOWN_ARTIFACT_STATUSES) {
      expect(describeArtifactStatus(s).unrecognised).toBe(false)
    }
  })

  it('survives an empty status without rendering a blank chip', () => {
    expect(describeArtifactStatus('').label).toBe('Unknown')
  })
})
