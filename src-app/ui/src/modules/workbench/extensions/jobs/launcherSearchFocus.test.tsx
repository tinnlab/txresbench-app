// @vitest-environment jsdom
//
// The launcher's search box must survive its own first keystroke.
//
// Reported symptom: typing the FIRST character into the analysis search drops focus, and
// clearing a non-empty query back to empty drops it again — so the user types one letter,
// loses the caret, and has to re-click to continue. Both failures sit on the SAME boundary
// (`query === ''` ⇄ `query !== ''`), which is the signature of a subtree containing the input
// being SWAPPED rather than updated: React unmounts the old node and mounts a new one, and a
// destroyed input cannot hold focus.
//
// So the assertions below are about the INPUT'S IDENTITY, not about a re-focus: the very same
// DOM node must still be `document.activeElement` after the keystroke. That distinction is the
// whole point — re-focusing in an effect would satisfy "is focused" while the remount (and
// everything else in that subtree: caret position, selection, IME composition) is still being
// thrown away.
//
// One character, not a word. A test that types "cluster" and then asserts focus passes
// VACUOUSLY against this bug: the remount happens on the ''→'c' transition only, so by the
// time the 7th keystroke lands the wrapper already exists and nothing swaps. Every assertion
// here is made after keystroke ONE (and after the mirror transition back to empty).
//
// Everything is driven through the REAL `LauncherPane` inside the REAL `WorkbenchProvider`
// with REAL registered analyses — the defect lives in the kit `Input` the pane renders, and a
// hand-rolled `<input>` in a fixture would not reproduce it.

import { act } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createWorkbenchApi, workbenchRegistry, type AnalysisContribution } from '@/modules/workbench/core'
import { makeFakeHost } from '@/modules/workbench/core/host/createHost'
import { WorkbenchProvider } from '@/modules/workbench/core/shell/WorkbenchContext'
import type { WorkbenchPane } from '../../core/shell/dock/paneModel'
import { LauncherPane } from './LauncherPane'

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as never
  if (!globalThis.CSS) (globalThis as { CSS?: unknown }).CSS = { escape: (v: string) => v }
})

/** Two launcher-visible analyses in one category. Neutral inventions — the search box's
 *  behaviour is not a function of what is in the list, but a list with rows in it means the
 *  RESULTS half of the pane really does swap between the query states. */
const ANALYSES: AnalysisContribution[] = [
  {
    id: 'test.alpha',
    extensionId: 'launcher-focus-test',
    apiVersion: '^1.0',
    title: 'Alpha',
    category: 'testing',
    appliesTo: [],
    produces: [],
    run: { kind: 'sandbox', runtime: 'bash', entry: 'run.sh' },
  },
  {
    id: 'test.beta',
    extensionId: 'launcher-focus-test',
    apiVersion: '^1.0',
    title: 'Beta',
    category: 'testing',
    appliesTo: [],
    produces: [],
    run: { kind: 'sandbox', runtime: 'bash', entry: 'run.sh' },
  },
] as AnalysisContribution[]

const PANE = { id: 'pane-launcher', kind: 'launcher' } as unknown as WorkbenchPane

async function mountLauncher(): Promise<HTMLInputElement> {
  const projectId = 'launcher-focus'
  const api = createWorkbenchApi(makeFakeHost({ projectId }), 'launcher-focus-test')
  await act(async () => {
    render(
      <WorkbenchProvider api={api} projectId={projectId} viewId="launcher-focus-view" canEdit>
        <LauncherPane pane={PANE} />
      </WorkbenchProvider>,
    )
  })
  await act(async () => {
    await Promise.resolve()
  })
  const input = document.querySelector<HTMLInputElement>('[data-testid="workbench-launcher-search"]')
  if (!input) throw new Error('the launcher search box did not render')
  return input
}

/** One keystroke, the way the browser delivers it: the field is focused, its value changes by
 *  one character, React re-renders. */
function typeOneCharacter(input: HTMLInputElement, next: string): void {
  input.focus()
  expect(document.activeElement, 'precondition: the field is focused before the keystroke').toBe(input)
  fireEvent.change(input, { target: { value: next } })
}

describe('the analysis launcher search box keeps focus across the empty ⇄ non-empty boundary', () => {
  beforeEach(() => {
    for (const a of ANALYSES) workbenchRegistry.analyses.register(a)
  })
  afterEach(() => {
    for (const a of ANALYSES) workbenchRegistry.analyses.remove(a.id)
    cleanup()
  })

  it('survives the FIRST character (the ""→"c" transition)', async () => {
    const input = await mountLauncher()

    typeOneCharacter(input, 'c')

    // The SAME node — not a replacement that happens to look the same. `toBe` is the remount
    // assertion; `activeElement` is the user-visible consequence of failing it.
    expect(
      document.body.contains(input),
      'the input the user was typing into must still be in the document after one character',
    ).toBe(true)
    expect(
      document.activeElement,
      'focus must survive the first keystroke — the user should not have to re-click to type the second',
    ).toBe(input)
    expect(input.value, 'and the character landed').toBe('c')
  })

  it('survives clearing a non-empty query back to empty (the mirror transition)', async () => {
    const input = await mountLauncher()

    // Get to the non-empty state first; whether THAT transition kept focus is the test above's
    // subject, so re-focus explicitly here and let this test own only the ''-ward direction.
    fireEvent.change(input, { target: { value: 'alpha' } })
    const live = document.querySelector<HTMLInputElement>('[data-testid="workbench-launcher-search"]')
    expect(live, 'the search box is still on screen with a query in it').toBeTruthy()
    live!.focus()
    expect(document.activeElement).toBe(live)

    fireEvent.change(live!, { target: { value: '' } })

    expect(
      document.body.contains(live!),
      'clearing the query must not replace the field the user is typing in',
    ).toBe(true)
    expect(
      document.activeElement,
      'focus must survive clearing the query — the caret should stay in the empty box',
    ).toBe(live)
    expect(live!.value).toBe('')
  })

  it('still offers a working clear (×) once there is a query', async () => {
    // The structural fix must not be bought by dropping the affordance it was tangled up with.
    // This arm matters HERE and not only in the kit's own suite: `just check-packages` excludes
    // `sdk/**` as another repo's suite, so a kit regression that silently removed the × would
    // reach this app with every gate green unless this app asserts it.
    const input = await mountLauncher()
    expect(document.querySelector('[aria-label="Clear"]'), 'no × on an empty search').toBeNull()

    fireEvent.change(input, { target: { value: 'alpha' } })

    const clear = document.querySelector<HTMLButtonElement>('[aria-label="Clear"]')
    expect(clear, 'a query gets a × to clear it').toBeTruthy()
    fireEvent.click(clear!)

    const live = document.querySelector<HTMLInputElement>('[data-testid="workbench-launcher-search"]')
    expect(live, 'the search box is still on screen').toBeTruthy()
    expect(live!.value, 'the × emptied the search').toBe('')
    expect(live, 'and did it in place — the field was never replaced').toBe(input)
    expect(
      document.querySelector('[data-testid="workbench-launcher-row-test.beta"]'),
      'clearing the search brings the filtered-out rows back',
    ).toBeTruthy()
  })

  it('keeps ONE input element across the whole transition (no swap, no duplicate)', async () => {
    const input = await mountLauncher()
    const boxes = () => document.querySelectorAll('[data-testid="workbench-launcher-search"]')

    expect(boxes().length, 'exactly one search box to begin with').toBe(1)
    typeOneCharacter(input, 'a')
    expect(boxes().length, 'still exactly one search box after the first character').toBe(1)
    expect(boxes()[0], 'and it is the same element the user focused').toBe(input)
  })
})
