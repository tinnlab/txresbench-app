/**
 * txrintake dev-gallery surfaces (PROV-UI-INTAKE-6, ITEM-11) — the module's
 * four stories rendered offline, one seeded surface per board state, entirely
 * from the synthetic `fixtures.ts` (INV-3: no real patient data, no
 * licensed-dataset rows).
 *
 * - `txr-intake-b`: screen B (Criteria.dc.html) — the six question groups
 *   and the live panel fed by the REAL `useStudyPreview` hook over the mock
 *   cassette (`MethodCatalogue.markers`; the `MethodCatalogue.eligibility`
 *   responder is extended at mount — see `extendEligibilityForPreviewStory`).
 *   The story seeds the store's answers on mount (the A→B walk's state), so
 *   the panel's request is the seeded one; toggling a marker-group checkbox
 *   re-runs the eligibility and the count/left-out list update (the
 *   responder is a function of the request body: checking ctDNA moves from
 *   26 fit / 13 left out to 28 fit / 11 left out — TEST-INT-14's
 *   "This updates as you answer").
 * - `txr-intake-c`: screen C (Files.dc.html) — the REAL FilesPage with the
 *   REAL store (the flow owns the drop → parse (PROV-FV-7, in-browser) →
 *   inspect → validate rounds). The story host publishes the fixture CSVs
 *   in the `txr-intake-story-fixtures` seam (JSON, hidden): the spec reads
 *   them and feeds the card inputs through the real file input, so the
 *   browser's own `File` construction + the REAL decode + the cassette's
 *   row-level facts run end to end (TEST-INT-15). The published pair is the
 *   problem measurements (row 14 `week 4`, P0187 rows 88..91, ldh/LDH
 *   spellings) + its fixed twin, and the patients file.
 * - `txr-intake-n`: screen N (PredictFiles.dc.html) — the REAL
 *   PredictFilesPage in predict mode (intent `pretrained`), the one
 *   measurements card, the aside, and the Continue → `/pretrained-models`
 *   walk (the story's navigation-result seam records the route the page's
 *   Continue reached — the component is never probed, the
 *   `txr-list-run-result` precedent).
 * - `txr-intake-narrow-390`: the three screens at 390 px — the board's
 *   mobile width, each in its own 390-wide frame with a SEEDED store state
 *   (a validated C, a predict N, an answered B), so the frames render the
 *   full content the narrow walk must fit (no horizontal overflow, cards
 *   stacking, Continue on-screen — TEST-INT-16's measured pattern).
 *
 * All data is the synthetic `fixtures.ts`; the module is reached through its
 * pages exactly as the router reaches them (the seeded frames mount the real
 * pages under MemoryRouter, so `useNavigate`/`Link` behave as in the app).
 *
 * DEV-ONLY: this file is picked up by the dev gallery's `import.meta.glob`
 * (`src/dev/gallery/main.tsx`) and is never in a production bundle path.
 */
import { lazy, useEffect } from 'react'
import type { ReactNode } from 'react'
import { Route, Routes, useLocation } from 'react-router-dom'
import { extendCassette, type ModuleGallery, type MockRequestContext } from '@txresbench/gallery'
import { parseCsvText } from '@/lib/txr-files/csv'
import { AppShell } from '../txrshell/components/AppShell'
import { StudyPage } from './pages/StudyPage'
import { FilesPage } from './pages/FilesPage'
import { PredictFilesPage } from './pages/PredictFilesPage'
import { StartPage } from './pages/StartPage'
import { TxrIntake } from './stores/TxrIntake.store'
import type { LoadedFile, StudyAnswers } from './types'
import {
  TXR_INTAKE_EXAMPLE_BUNDLE,
  TXR_INTAKE_EXAMPLE_SET,
  TXR_INTAKE_FIXTURE_BUNDLE,
  TXR_INTAKE_GROUPS,
  TXR_INTAKE_VOCABULARY,
  txrInspectResponse,
  txrPreviewEligibility,
  txrValidateResponse,
  type FixtureValidationBody,
} from './fixtures'
import { resolveJoins } from './lib/flow'
import { TXRLIST_ELIGIBILITY } from '../txrlist/fixtures'

// ── the story-side seams (the gallery-e2e reads these, never the pages) ──

/** The story host publishes its fixture bytes for the spec's File construction. */
function FixtureSeam() {
  return (
    <pre
      data-testid="txr-intake-story-fixtures"
      style={{ display: 'none' }}
      aria-hidden
    >
      {JSON.stringify(TXR_INTAKE_FIXTURE_BUNDLE)}
    </pre>
  )
}

/** The navigate-result seam (the route the page's Continue actually reached). */
function NavigationResultLine() {
  const location = useLocation()
  return (
    <pre data-testid="txr-intake-nav-result" style={{ margin: 8, fontSize: 11, color: 'var(--txr-muted)', overflowWrap: 'anywhere' }}>
      {location.pathname}
    </pre>
  )
}

/** The B story's seeded answers: colorectal, risk by a day, no groups yet. */
function seedStudyAnswers(fresh = true): void {
  if (fresh) TxrIntake.reset()
  TxrIntake.patchStudy({
    disease: 'colorectal',
    treatment: 'immunotherapy',
    outcome: 'progression-by-day',
    beforeTreatment: 'always',
    drawsDuringTreatment: 2,
    lastDrawDay: 56,
    markerGroups: Object.fromEntries(TXR_INTAKE_GROUPS.map(group => [group.id, false])),
  } satisfies Partial<StudyAnswers>)
  TxrIntake.patchParameters({ decision_day: 56 })
}

/**
 * The eligibility responder of the screen-B story. `MethodCatalogue.eligibility`
 * ONE-owner-per-endpoint is the gallery registry's rule (registry-core.ts), and
 * the endpoint's owner is the `txrlist` module (its E story posts the
 * `{inventory: …}` body). The B story needs the PREVIEW-shaped responder (a
 * function of the request body — "This updates as you answer"), so it extends
 * the ACTIVE cassette at mount through the mock engine's public extension API:
 * the PREVIEW branch is this module's fixture responder, the INVENTORY branch
 * delegates to txrlist's own fixture bytes — the module's one extension cannot
 * disturb the sibling story's data (the extension runs before the panel's
 * debounced first fetch, so the B screen never sees the inventory shape).
 * Recorded in DRIFT-1 ITEM-11.
 */
function extendEligibilityForPreviewStory(): void {
  extendCassette({
    'MethodCatalogue.eligibility': (ctx: MockRequestContext) => {
      const body = (ctx.body ?? {}) as { preview?: unknown; inventory?: unknown }
      if (body.preview !== undefined) {
        return txrPreviewEligibility(body as Parameters<typeof txrPreviewEligibility>[0])
      }
      return TXRLIST_ELIGIBILITY
    },
  })
}

/** The adopted-file shell (the store's birth shape for a decoded table). */
function loadedFrom(table: ReturnType<typeof parseCsvText>): LoadedFile {
  return {
    source: table.source,
    table,
    inspection: null,
    problems: [],
    prepared: false,
    joinOffers: [],
    vocabOffers: [],

    columnOffers: [],
  }
}

/** Seed the store's C screen with the validated (fixed) file pair. */
function seedValidatedFiles(fresh = true): void {
  if (fresh) TxrIntake.reset()
  const patientsTable = parseCsvText(
    TXR_INTAKE_FIXTURE_BUNDLE.patients,
    { kind: 'patients' },
    'fixture-patients.csv',
  )
  const measurementsTable = parseCsvText(
    TXR_INTAKE_FIXTURE_BUNDLE.measurementsFixed,
    { kind: 'measurements' },
    'fixture-measurements.csv',
  )
  TxrIntake.adoptFile('patients', loadedFrom(patientsTable))
  TxrIntake.adoptFile('measurements', loadedFrom(measurementsTable))
  const patientsInspection = txrInspectResponse({ kind: 'patients', table: patientsTable })
  const measurementsInspection = txrInspectResponse({
    kind: 'measurements',
    table: measurementsTable,
  })
  TxrIntake.patchFile('patients', {
    inspection: patientsInspection,
    problems: patientsInspection.problems,
    prepared: true,
  })
  TxrIntake.patchFile('measurements', {
    inspection: measurementsInspection,
    problems: measurementsInspection.problems,
    prepared: true,
  })
  const response = txrValidateResponse({
    mode: 'files',
    measurements: measurementsTable,
    patients: patientsTable,
  })
  const joinOffers = resolveJoins(response.markers, [])
  TxrIntake.patchFile('measurements', { joinOffers })
  TxrIntake.applyValidation(response, TxrIntake.currentValidationKey())
}

/** Seed the store's N screen (predict intent, the clean predict file). */
function seedPredictFile(fresh = true): void {
  if (fresh) TxrIntake.reset()
  TxrIntake.setIntent('pretrained')
  const predictTable = parseCsvText(
    TXR_INTAKE_FIXTURE_BUNDLE.predict,
    { kind: 'measurements' },
    'fixture-predict.csv',
  )
  TxrIntake.adoptFile('predictMeasurements', loadedFrom(predictTable))
  const inspection = txrInspectResponse({ kind: 'measurements', table: predictTable })
  TxrIntake.patchFile('predictMeasurements', {
    inspection,
    problems: inspection.problems,
    prepared: true,
  })
  const response = txrValidateResponse({ mode: 'predict', measurements: predictTable })
  TxrIntake.applyValidation(response, TxrIntake.currentValidationKey())
}

// ── the story views ──

/** Screen B — the seeded answers + the live panel (cassette-fed). */
function BStoryView() {
  return <StudyPage />
}

/** Screen C — the real page; the spec drives the drop through the seam. */
function CStoryView() {
  useEffect(() => {
    TxrIntake.reset()
  }, [])
  return (
    <div>
      <FilesPage />
      <FixtureSeam />
      <NavigationResultLine />
    </div>
  )
}

/** Screen N — predict mode, Continue into /pretrained-models. */
function NStoryView() {
  useEffect(() => {
    TxrIntake.reset()
    TxrIntake.setIntent('pretrained')
  }, [])
  return (
    <div>
      <PredictFilesPage />
      <FixtureSeam />
      <NavigationResultLine />
    </div>
  )
}

/** One 390-px frame of the narrow story. */
function NarrowFrame({
  label,
  title,
  children,
}: {
  label: string
  title: string
  children: ReactNode
}) {
  return (
    <section
      data-testid={`txr-intake-narrow-${label}`}
      style={{ width: 390, maxWidth: '100%', minWidth: 0 }}
    >
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--txr-muted)', marginBottom: 4 }}>
        {title} — 390 px
      </div>
      <div style={{ border: '1px solid var(--txr-border)', borderRadius: 10 }}>{children}</div>
    </section>
  )
}

/**
 * The three screens at the board's mobile width, stacked in the story.
 *
 * The frames share ONE store (the app's real singleton) and mount together,
 * so their seeds must COMPOSE rather than each reset it: the store keeps the
 * study answers (B), the validated file pair (C) and the predict file (N)
 * as separate slices, and the shared `validation` slot ends as the N
 * response — exactly the state the standalone N story leaves (the frames'
 * own flows never re-run: the slot is non-null when they mount). The
 * seeding runs in THIS view's effect (after the frames' effects — React
 * runs child effects first), with the standalone seeds' resets skipped.
 */
function NarrowStoryView() {
  useEffect(() => {
    extendEligibilityForPreviewStory()
    seedStudyAnswers()
    seedValidatedFiles(false)
    seedPredictFile(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      <NarrowFrame label="b" title="Screen B — Your study">
        <StudyPage />
      </NarrowFrame>
      <NarrowFrame label="c" title="Screen C — Your files">
        <FilesPage />
      </NarrowFrame>
      <NarrowFrame label="n" title="Screen N — Add the patients to predict">
        <PredictFilesPage />
      </NarrowFrame>
    </div>
  )
}

// ── the use-example story (qa-fixes3 ITEM-5) ────────────────────────────────

/**
 * The ONE-CLICK example proof: the REAL StartPage under the story's
 * descendant Routes, so the example flow's navigation is observed IN FRAME
 * instead of unmounting the story — the three Use-example buttons land on
 * the path's file step, the file screens run the SAME inspect/validate a
 * user drop runs (the cassette answers with the example family bytes), the
 * Continue button enables on the warning-free state, and the next step's
 * route records in the navigation seam (the sibling stories' pattern).
 * The reuse path's example-set poll is the ITEM-3 ready answer extended at
 * mount — the one endpoint the module family does not own.
 */
function UseExampleStoryView() {
  useEffect(() => {
    TxrIntake.reset()
    extendCassette({
      'Models.exampleSet': () => TXR_INTAKE_EXAMPLE_SET,
    })
  }, [])
  return (
    <section style={{ minWidth: 0 }}>
      <Routes>
        <Route path="/" element={<StartPage />} />
        <Route path="/files" element={<FilesPage />} />
        <Route path="/predict-files" element={<PredictFilesPage />} />
        <Route path="/choose-methods" element={<ExampleStepSeam path="/choose-methods" />} />
        <Route path="/pretrained-models" element={<ExampleStepSeam path="/pretrained-models" />} />
        <Route path="/saved-models" element={<ExampleStepSeam path="/saved-models" />} />
      </Routes>
      <NavigationResultLine />
    </section>
  )
}

/** The route the Continue reached (the example walk's next step). */
function ExampleStepSeam({ path }: { path: string }) {
  return (
    <p data-testid="txr-use-example-step" style={{ margin: 12, fontSize: 12, color: 'var(--txr-muted)' }}>
      next step: {path}
    </p>
  )
}

/** The one story host for the app-shell ITEM-2 route byte: the REAL page
 *  INSIDE the REAL shell, so the shell's mode class rides the document and
 *  the page's regions get their definite heights from the routed area —
 *  the same frame a clinician sees (the standalone story frames above
 *  answer behaviour; these answer LAYOUT). */
function ShellRouteView({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>
}

// ── the module's gallery seed ──

export const gallery: ModuleGallery = {
  // The stories' mock endpoints — the ONLY network-ish surface the module
  // has. The keys are the generated `ApiEndpoints` ids (DRIFT-1 ITEM-2 #4's
  // recorded reconcile fact: the plan's `Markers.list`/`Methods.*`/
  // `FileValidation.templates|examples` spell the CONSUMER vocabulary, the
  // real ids are `MethodCatalogue.*` / `FileValidation.*`). The inspect /
  // validate responders are FUNCTIONS of the request body: the mock reads
  // the request's parsed table the browser produced, so the story's facts
  // (row 14, rows 88..91, the join question, the ctDNA toggle) are derived
  // from the actual fixture bytes, never hardcoded next to them. The
  // template/example bodies are the committed synthetic heads (the
  // provider's assets, INV-3) through the same text channel the real server
  // uses. `MethodCatalogue.eligibility` is deliberately NOT here — the
  // endpoint's single owner is `txrlist` (registry-core.ts's one-owner-per-
  // endpoint rule); the B story's preview responder is extended at mount
  // (`extendEligibilityForPreviewStory`).
  cassette: {
    'MethodCatalogue.markers': TXR_INTAKE_VOCABULARY,
    'FileValidation.inspect': (ctx: MockRequestContext) =>
      txrInspectResponse((ctx.body ?? {}) as Parameters<typeof txrInspectResponse>[0]),
    'FileValidation.validate': (ctx: MockRequestContext) =>
      txrValidateResponse((ctx.body ?? {}) as FixtureValidationBody),
    'FileValidation.template': (ctx: MockRequestContext) =>
      ctx.params.kind === 'measurements'
        ? TXR_INTAKE_FIXTURE_BUNDLE.templateMeasurements
        : TXR_INTAKE_FIXTURE_BUNDLE.templatePatients,
    // qa-fixes3 ITEM-5: the example family — the SAME bytes every Use-example
    // flow consumes ("Download the full example" and the one-click buttons
    // share one source of truth; the old mock served the problem fixture's
    // twin under the example name).
    'FileValidation.example': (ctx: MockRequestContext) =>
      ctx.params.kind === 'predict-measurements'
        ? TXR_INTAKE_EXAMPLE_BUNDLE.predictMeasurements
        : ctx.params.kind === 'measurements'
          ? TXR_INTAKE_EXAMPLE_BUNDLE.measurements
          : TXR_INTAKE_EXAMPLE_BUNDLE.patients,
  },

  seeded: [
    {
      slug: 'txr-intake-b',
      title: 'Your study (screen B) — the live fit panel',
      note: 'The six question groups (seeded: colorectal, immunotherapy, risk by a day, no marker groups) with the REAL eligibility hook over the mock cassette: "26 of 39 methods fit" (22 can run + 4 for some patients — the head-to-the-tail inclusive count) + the left-out list with one reason per method; checking the ctDNA group re-runs the panel (28 fit, 11 left out).',
      path: '/study',
      initialPath: '/study',
      component: lazy(() => Promise.resolve({ default: BStoryView })),
      setup: () => {
        extendEligibilityForPreviewStory()
        seedStudyAnswers()
      },
    },
    {
      slug: 'txr-intake-c',
      title: 'Your files (screen C) — the shared card flow',
      note: 'The two file cards (patients + measurements) with the board column tables, template/example downloads and the drop zones; the spec drops the fixture files through the seam below (the real in-browser decode runs first), the card then reports the row-level problems and the ldh/LDH join question, and Continue stays disabled until the warnings-only state. The frame mounts the page under a catch-all route (initialPath /files) so the Continue navigation is observable in the route seam below instead of unmounting the story.',
      path: '*',
      initialPath: '/files',
      component: lazy(() => Promise.resolve({ default: CStoryView })),
      fullHeight: true,
    },
    {
      slug: 'txr-intake-n',
      title: 'Add the patients to predict (screen N)',
      note: 'The ONE measurements card (no patients file, no outcomes), the "What the models look for" aside, and Continue: choose models — in predict mode for intent pretrained the button reads /pretrained-models (recorded in the seam below; the frame mounts under a catch-all route so the navigation is observable).',
      path: '*',
      initialPath: '/predict-files',
      component: lazy(() => Promise.resolve({ default: NStoryView })),
      fullHeight: true,
    },
    {
      slug: 'txr-intake-use-example',
      title: 'One click to a filled flow (qa-fixes3 ITEM-5)',
      note: 'The Start screen under in-frame routes: each card\'s "Use example" prepares the example family in ONE click and lands on the path\'s file step (train → /files, the two predict paths → /predict-files); the file screens run the same inspect/validate a user drop runs and enable Continue on the warning-free state; Continue records the next step in the seam. The reuse path\'s example set answers ready (ITEM-3) so the poll settles in one round.',
      path: '/*',
      initialPath: '/',
      component: lazy(() => Promise.resolve({ default: UseExampleStoryView })),
      fullHeight: true,
    },
    {
      slug: 'txr-intake-narrow-390',
      title: 'Screens B, C and N at 390 px',
      note: 'The intake screens at the board\'s mobile width, seeded to their loaded states: the questions + panel stack, the two cards stack (the role table scrolls inside the card, never the page), the predict card + aside stack, and every Continue is on-screen — no horizontal overflow (TEST-INT-16).',
      path: '/narrow-390',
      initialPath: '/narrow-390',
      component: lazy(() => Promise.resolve({ default: NarrowStoryView })),
      fullHeight: true,
    },
    // app-shell ITEM-2 — the route byte: each route inside the REAL shell
    // (the audit's section-4 legs are driven by `txr-shell-routes.spec.ts`
    // over these surfaces at the three desktop sizes + 390 flow).
    {
      slug: 'txr-shell-route-start',
      title: 'Start (screen A) inside the shell',
      note: 'The ITEM-2 route byte: the body is ONE scroll region (the audit\'s "fits in one screen; if the window is short, the body region scrolls"), the document never scrolls in shell mode, the header stays put while the region scrolls.',
      path: '/',
      initialPath: '/',
      component: lazy(() =>
        Promise.resolve({
          default: () => (
            <ShellRouteView>
              <StartPage />
            </ShellRouteView>
          ),
        }),
      ),
    },
    {
      slug: 'txr-shell-route-study',
      title: 'Your study (screen B) inside the shell',
      note: 'The ITEM-2 route byte: the step + title fixed, the questionnaire and the methods-fit panel EACH their own region (side by side at 1024+), the Continue / Skip / Use-example row pinned in the bottom bar.',
      path: '/study',
      initialPath: '/study',
      component: lazy(() =>
        Promise.resolve({
          default: () => (
            <ShellRouteView>
              <StudyPage />
            </ShellRouteView>
          ),
        }),
      ),
      setup: () => {
        extendEligibilityForPreviewStory()
        seedStudyAnswers()
      },
    },
    {
      slug: 'txr-shell-route-files',
      title: 'Your files (screen C) inside the shell',
      note: 'The ITEM-2 route byte: the step + title fixed, the two file cards in ONE region (each preview table its own bounded box with the sticky header), the file status + Continue pinned below.',
      path: '*',
      initialPath: '/files',
      component: lazy(() =>
        Promise.resolve({
          default: () => (
            <ShellRouteView>
              <FilesPage />
            </ShellRouteView>
          ),
        }),
      ),
      setup: () => seedValidatedFiles(),
    },
    {
      slug: 'txr-shell-route-predict-files',
      title: 'Add the patients to predict (screen N) inside the shell',
      note: 'The ITEM-2 route byte: the step + title fixed, the one measurements card + the aside in ONE region, Continue pinned below.',
      path: '*',
      initialPath: '/predict-files',
      component: lazy(() =>
        Promise.resolve({
          default: () => (
            <ShellRouteView>
              <PredictFilesPage />
            </ShellRouteView>
          ),
        }),
      ),
      setup: () => seedPredictFile(),
    },
  ],
}
