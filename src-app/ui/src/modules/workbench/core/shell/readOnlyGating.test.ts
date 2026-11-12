import { describe, expect, it } from 'vitest'
import { PRIMARY_CONTAINER, type ContainerId } from '@txresbench/dock'
import { launcherRowEnabled, paneChromeAction } from './readOnlyGating'
import { JOB_STOP_UNAVAILABLE_REASON, jobStopUnavailableReason } from '@/modules/jobs/stopAuthority'

// TEST (unit, ITEM-29/30) — the pure read-only + pop-out-chrome predicates the panes/frame
// gate their affordances with; a popped-out pane offers "return", not a second "pop out".
//
// `jobStopVisible` USED to be tested here and is deliberately gone. It answered "may this user
// stop this job?" from the per-project EDIT role, which is a different question with a
// different answer (the right is the creator / the scope owner / an admin). The server states
// it per row now, so what is asserted below is that the client renders the STATED answer and
// owns no copy of the rule — see `modules/jobs/stopAuthority`.

describe('launcherRowEnabled (ITEM-29)', () => {
  it('enables on AVAILABILITY alone — the row opens a form, which a viewer may read', () => {
    // Was `launchable && canEdit`, and asserted here as "viewer: never launch". The premise was
    // wrong rather than the arithmetic: the row drives `analysis.launch`, which OPENS the
    // analysis' form and enqueues nothing (declared `mutating: false` since this change). The
    // write it leads to is Run, gated inside `AnalysisRunPanel` — which carries a purpose-built
    // "viewers cannot run analyses" branch that this predicate stood in front of.
    expect(launcherRowEnabled(true, true)).toBe(true)
    expect(launcherRowEnabled(true, false)).toBe(true) // viewer: may OPEN the form
    expect(launcherRowEnabled(false, true)).toBe(false) // unavailable analysis
    expect(launcherRowEnabled(false, false)).toBe(false)
  })

  it('NEGATIVE CONTROL — the role still gates something, it is just not Stop', () => {
    // Without a negative control the change above reads as "the viewer role stopped gating
    // anything". It has not: `AnalysisRunPanel` still renders Run only for an editor. What
    // left this file is the STOP gate, and it left because the role was the wrong source for
    // it — not because roles stopped mattering.
    expect(launcherRowEnabled(false, true)).toBe(false)
  })
})

describe('the stop right is the SERVER\'s answer, never a role re-derived here', () => {
  it('renders available when the server said the caller may stop, refused when it did not', () => {
    // The whole client-side rule, in one line each way: no owner_id comparison, no `canEdit`,
    // no membership lookup — just the boolean that arrived on the wire.
    expect(jobStopUnavailableReason(true)).toBeUndefined()
    expect(jobStopUnavailableReason(false)).toBe(JOB_STOP_UNAVAILABLE_REASON)
  })

  it('states WHO may stop, so a refused user knows what to ask for', () => {
    // A bare disabled control teaches nothing. `unavailableReason` puts this string in the
    // tooltip AND in an `aria-describedby` node, so the refusal reaches every user.
    expect(JOB_STOP_UNAVAILABLE_REASON).toBe(
      "Only this run's creator or the owner of the dataset or project it runs on can stop it",
    )
  })
})

describe('paneChromeAction (ITEM-30)', () => {
  it('main window → pop out; a popup window → return to main', () => {
    expect(paneChromeAction(PRIMARY_CONTAINER)).toBe('popout')
    expect(paneChromeAction('popup-1' as ContainerId)).toBe('return')
    expect(paneChromeAction('popup-42' as ContainerId)).toBe('return')
  })
})
