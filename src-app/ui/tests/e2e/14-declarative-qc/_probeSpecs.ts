// The fixture PACKAGE TEXT the runtime-drop e2e specs author — extracted from
// `manifest-ui-separation.spec.ts` so it has TWO consumers: the e2e that drops it into a
// live server, and a unit test that parses it through the real `parseViewSpec`
// (`src/modules/workbench/core/runtime/droppedSpecCorpus.test.ts`).
//
// WHY IT LIVES IN ITS OWN MODULE. These strings are view_specs authored OUTSIDE the app
// tree — the same position a third-party package is in. Nothing in the repo validated them
// except an 8-hour `workers: 1` e2e, so a change to the spec VALIDATOR could invalidate
// them and the only report was a 30s registry-poll timeout in a browser. That happened:
// ITEM-28 (`""` is not an unset on a closed-set control) migrated the in-tree specs and the
// gallery fixtures in one commit and did not touch these, because nothing could see them.
// Importing them from a vitest is what makes that class of break cost seconds.
//
// No `@playwright/test` import here, deliberately: the unit test imports this module, and a
// module that pulls in playwright's `test.describe` at import time cannot be imported by
// anything else.

export interface AnalysisShape {
  id: string
  title: string
  slot: string
  datatype: string
  ui: string[]
}

/** A manifest declaring ONE analysis and NOTHING about its UI beyond WHICH FILES render it.
 *  No label, no help text, no field order, no form schema — INV-1's shape, which is the
 *  precondition INV-2 rests on. */
export function manifestText(pkgId: string, a: AnalysisShape): string {
  return `id: ${pkgId}
name: E2E probe package
publisher: txr-e2e
version: 0.0.1
apiVersion: "1.0"
contributes:
  analyses:
    - id: ${a.id}
      category: probe
      title: ${a.title}
      appliesTo:
        - { slot: ${a.slot}, type_id: ${a.datatype} }
      produces: []
      ui: [${a.ui.join(', ')}]
      run: { kind: sandbox, runtime: python, entry: compute/probe.py }
      schedule: { class: normal }
`
}

/** A form whose control LABEL and candidate SOURCE are the view's own declarations. Both are
 *  parameters here for one reason: the test varies the source and holds the manifest byte-
 *  identical, which is the whole of INV-2.
 *
 *  `pick` defaults to `null`, NOT `""`. It is bound to an `artifact_ref` — a CLOSED SET,
 *  which never offers the empty string — and `parseViewSpec` refuses `""` there by design
 *  (R1/INV-2, ITEM-28). `null` is the only unset. */
export function pickerViewText(opts: {
  specId: string
  title: string
  label: string
  sourceDatatype: string
  analysisId?: string
  slot?: string
}): string {
  const runBits = opts.analysisId
    ? `
  - id: probeRun
    kind: button
    label: Start probe
    variant: primary
    onClick: probe.run`
    : ''
  const runAction = opts.analysisId
    ? `
  - id: probe.run
    title: Start probe
    permission: jobs::use
    mutating: true
    params: {}
    body:
      - run_processor:
          id: ${opts.analysisId}
          inputs: { ${opts.slot}: "$state.pick" }
          params: {}
          into: probeJob
      - toast: { success: Probe launched }`
    : ''
  return `id: ${opts.specId}
title: ${opts.title}
permission: jobs::use

state:
  pick: { type: string, default: null }

widgets:
  - id: probePicker
    kind: artifact_ref
    label: ${opts.label}
    source: { datatype: ${opts.sourceDatatype} }
    value: "$state.pick"
    onChange: probe.setPick${runBits}

actions:
  - id: probe.setPick
    title: Set the probe source
    permission: jobs::use
    mutating: true
    stateful: true
    params: { value: string }
    body:
      - set: { pick: "$params.value" }${runAction}
`
}

/** A fragment view carrying ONE inert widget. Two of these stacked is TEST-3's subject. */
export function fragmentViewText(
  specId: string,
  title: string,
  widgetId: string,
  text: string,
): string {
  return `id: ${specId}
title: ${title}
permission: jobs::use
state: {}
widgets:
  - id: ${widgetId}
    kind: alert
    tone: info
    text: ${text}
actions: []
`
}

/**
 * Every VIEW text this module can produce, in the shapes the e2e actually drops — the
 * corpus the unit guard parses.
 *
 * Built from the SAME builders the e2e calls (not a transcription of them), so a builder
 * that changes is a corpus that changes. The datatype strings are opaque to the parser, so
 * a literal is fine here where the e2e reaches for `_fixtures.ts`.
 */
export function droppedViewCorpus(): Array<{ name: string; yaml: string }> {
  return [
    {
      // TEST-2 / INV-2's drop 1 + drop 2 differ only in `sourceDatatype`, which the parser
      // does not distinguish — one entry covers both.
      name: 'pickerViewText (no run action) — INV-2',
      yaml: pickerViewText({
        specId: 'probe/form',
        title: 'Probe form',
        label: 'Chosen probe input',
        sourceDatatype: 'metadata/column',
      }),
    },
    {
      name: 'pickerViewText (with run action) — INV-4',
      yaml: pickerViewText({
        specId: 'probe/launch',
        title: 'Probe launch',
        label: 'Chosen probe input',
        sourceDatatype: 'metadata/column',
        analysisId: 'e2e-probe-launch.run',
        slot: 'source',
      }),
    },
    {
      name: 'fragmentViewText (first) — INV-3',
      yaml: fragmentViewText('probe/frag-a', 'Fragment A', 'fragA', 'first fragment'),
    },
    {
      name: 'fragmentViewText (second) — INV-3',
      yaml: fragmentViewText('probe/frag-b', 'Fragment B', 'fragB', 'second fragment'),
    },
  ]
}
