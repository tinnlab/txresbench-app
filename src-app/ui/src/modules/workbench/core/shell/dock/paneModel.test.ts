import { describe, it, expect, afterEach } from 'vitest'
import {
  PANE_KINDS,
  isPaneKind,
  paneRenderers,
  resolvePaneRenderer,
  paneTitle,
  registerPaneRenderer,
  authoredRefSubject,
  notifyPaneSubjectsChanged,
  FallbackPane,
} from './paneModel'

// TEST-201 (ITEM-7) — the pane model validates the `kind` union and the `paneRenderers` lookup
// resolves a component for EVERY kind + a VISIBLE fallback (not a crash) for an unknown kind.
describe('paneModel (ITEM-7)', () => {
  it('validates WorkbenchPane kind against the union', () => {
    for (const k of PANE_KINDS) expect(isPaneKind(k)).toBe(true)
    expect(isPaneKind('bogus')).toBe(false)
    // a WorkbenchPane whose kind is out-of-union fails the guard.
    const smuggled = { id: 'x', kind: 'nope' } as unknown as { kind: string }
    expect(isPaneKind(smuggled.kind)).toBe(false)
  })

  it('resolves a component for every kind and a visible fallback for an unknown kind', () => {
    for (const k of PANE_KINDS) {
      expect(typeof paneRenderers[k]).toBe('function')
      expect(typeof resolvePaneRenderer(k)).toBe('function')
    }
    // an unknown kind resolves to the visible fallback component (never undefined / a crash).
    expect(resolvePaneRenderer('totally-unknown')).toBe(FallbackPane)
    expect(typeof resolvePaneRenderer('totally-unknown')).toBe('function')
  })
})

// A PANE'S TITLE NEVER PRINTS AN IDENTITY IT WAS NOT TOLD IS READABLE.
//
// The assertion that matters here is the DEFAULT, not any one kind: `paneTitle` used to end
// `pane.ref ? base + ' · ' + ref : base`, which put a job/run/artifact uuid on the tab for every
// kind nobody had hand-carved an exception for. Restoring the old behaviour for a single kind
// would pass a per-kind test and re-open the hole for the next kind, so the test is written on
// the contract: a kind with NO registered subject resolver shows its base title, whatever its ref.
describe('paneTitle subject resolution', () => {
  // `paneModel` is registry state shared across this file; put the kind back after each case.
  afterEach(() => {
    registerPaneRenderer('run', FallbackPane, { subject: authoredRefSubject })
    registerPaneRenderer('jobs', FallbackPane)
  })

  it('shows the kind title alone when the kind declares no subject resolver', () => {
    registerPaneRenderer('jobs', FallbackPane)
    expect(paneTitle({ id: 'a', kind: 'jobs' })).toBe('Jobs')
    // The defect this replaces: the ref is a job UUID, and it used to be printed.
    expect(paneTitle({ id: 'b', kind: 'jobs', ref: '3f2a1c8e-9d4b-4c1e-8a77-2b6f0d1e5a90' })).toBe('Jobs')
  })

  it('appends the subject a registered resolver returns', () => {
    registerPaneRenderer('jobs', FallbackPane, { subject: () => 'Nightly filter' })
    expect(paneTitle({ id: 'c', kind: 'jobs', ref: 'job-1' })).toBe('Jobs · Nightly filter')
  })

  it('shows the base title when the resolver has no answer YET, or answers blank', () => {
    registerPaneRenderer('jobs', FallbackPane, { subject: () => null })
    expect(paneTitle({ id: 'd', kind: 'jobs', ref: 'job-1' })).toBe('Jobs')
    registerPaneRenderer('jobs', FallbackPane, { subject: () => '   ' })
    expect(paneTitle({ id: 'e', kind: 'jobs', ref: 'job-1' })).toBe('Jobs')
  })

  it('survives a resolver that throws — a bad ref must not take the tab strip down', () => {
    registerPaneRenderer('jobs', FallbackPane, {
      subject: () => {
        throw new Error('malformed ref')
      },
    })
    expect(paneTitle({ id: 'f', kind: 'jobs', ref: 'job-1' })).toBe('Jobs')
  })

  it('a re-registration that names no subject CLEARS the previous one', () => {
    registerPaneRenderer('jobs', FallbackPane, { subject: () => 'sticky' })
    expect(paneTitle({ id: 'g', kind: 'jobs', ref: 'job-1' })).toBe('Jobs · sticky')
    registerPaneRenderer('jobs', FallbackPane)
    expect(paneTitle({ id: 'g', kind: 'jobs', ref: 'job-1' })).toBe('Jobs')
  })

  it('a kind whose ref is AUTHORED text keeps showing it (the `run` analysis id)', () => {
    registerPaneRenderer('run', FallbackPane, { subject: authoredRefSubject })
    expect(paneTitle({ id: 'h', kind: 'run', ref: 'demo.leiden' })).toBe('Run · demo.leiden')
    expect(paneTitle({ id: 'i', kind: 'canvas' })).toBe('Canvas')
  })

  it('…but "authored" is a CLAIM, and a uuid falsifies it for that pane', () => {
    // A kind declares `authoredRefSubject` because its ref is a slug someone wrote. If a
    // generated id turns up in that field anyway — a new caller, a hydrated layout — the claim is
    // wrong for THIS pane, and the resolver drops the subject rather than printing the uuid the
    // whole change exists to remove.
    registerPaneRenderer('run', FallbackPane, { subject: authoredRefSubject })
    expect(paneTitle({ id: 'j', kind: 'run', ref: '3f2a1c8e-9d4b-4c1e-8a77-2b6f0d1e5a90' })).toBe('Run')
    // …and it must not over-reach: an id that merely contains hex-ish words is still authored text.
    expect(paneTitle({ id: 'k', kind: 'run', ref: 'deadbeef.cafe.analysis' })).toBe(
      'Run · deadbeef.cafe.analysis',
    )
  })
})

// `notifyPaneSubjectsChanged` is the seam a tab strip subscribes to (`usePaneSubjectEpoch`) so a
// name that ARRIVES reaches a tab that is already on screen. It is exercised end-to-end by
// `regions/paneSubjectTitle.test.tsx` (render → name arrives → the tab's label changes) — the
// only place a "did anything re-render?" claim can be made honestly — and is re-exported here so
// a caller outside this module has a supported way to announce a change.
describe('paneModel exports the subject-change seam', () => {
  it('is callable and does not throw with no subscribers', () => {
    expect(() => notifyPaneSubjectsChanged()).not.toThrow()
  })
})
