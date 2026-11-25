import { useCallback, useEffect } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Alert, Button, Skeleton } from '@txresbench/kit'
import { useDocumentTitle } from '@/modules/txrshell/lib/document-title'
import { PageFrame } from '@/modules/txrshell/components/PageFrame'
import { ScrollRegion } from '@/modules/txrshell/components/ScrollRegion'
import { useRunnableMethodCount } from '../data/useRunnableMethodCount'
import { usePredictModelCounts } from '../data/usePredictModelCounts'
import { TxrUseExampleButton } from '../components/TxrUseExampleButton'
import { beginPath } from '../lib/stepTrail'
import { runAction } from '@/core/actions/defineAction'
import { useAppMode } from '@/modules/demo'
import { DEMO_START_HINT, DEMO_START_PRIMARY } from '@/modules/demo/copy'
import type { IntakeIntent } from '../types'
import { FLOW_ROUTES } from '@/modules/txrshell/lib/flowSteps'
import { useModelFileImport } from '@/modules/txrmodels/data/useModelFileImport'

/**
 * Screen A — Start (board Start.dc.html): the TWO FLOW paths as cards
 * (Path 1 learn from my data, Path 2 predict new patients — the
 * predict-card merge's round 1: the old ready-made and saved-model cards
 * are one card now, with a counts-gated state), the "Not sure which fits?"
 * banner pointing at the per-card "Use example" buttons, and the dev/web
 * web-URL notice (DEC-12).
 *
 * Board-copy rule (DEC-13): board wording is used verbatim where it is a
 * label or behavior; every NUMBER on the board is a design example, never
 * data. The learn card's count is the LIVE runnable count (CONS-UI-INTAKE-3
 * via `useRunnableMethodCount`).
 *
 * The two cards' state (round 1): "some model exists" = lab > 0 OR
 * saved > 0 OR imported > 0 (`usePredictModelCounts`: lab = the ready-made
 * catalogue, saved = store models with provenance `run`, imported =
 * provenance `imported` — a downloaded lab model, provenance `pretrained`,
 * is NOT saved). While all three counts are KNOWN and 0 (state B): the
 * learn card's eyebrow+body change to the "start here" copy and the
 * predict card gets its note, its one bullet and the two buttons (Use
 * example primary + Open a model file). Loading (a count unknown and none
 * known > 0) and FAILED counts never show state B: the predict card shows
 * state A's title and buttons with skeleton lines; the learn card shows
 * state A. Demo mode (ITEM-6): the predict card is state A (the demo has
 * its recorded lab models), the primary goes and "Use example" becomes the
 * primary reading DEMO_START_PRIMARY, and "Open a model file" is hidden.
 *
 * Badge (KEPT text): "Recommended to start" sits on the predict card when
 * the lab catalogue has at least one model (`lab > 0`), else on "Learn
 * from my data" (also while loading or failed).
 *
 * Intent navigation (PROV-UI-INTAKE-1 + DEC-20): each card's button sets the
 * intent FIRST (the store's `setIntent` maps it to the flow's mode) and then
 * navigates to the intake route the path starts on — predict → `/predict-files`
 * (N), train → `/files` (the learn path's files come first, then the study
 * questions; `txrshell/lib/flowSteps.ts`). "Use example" (qa-fixes3 ITEM-4,
 * predict-card merge round 1) is the registered `flow.useExample` — ONE
 * click sets the intent AND the example files/answers AND (predict) the
 * example set, and lands on the path's file step. "Open a model file" is
 * the registered `models.openModelFile`: a human click opens the `.txr`
 * picker in place and a successful import lands on the Models page with the
 * imported model (the agent's path — no gesture — navigates to `/models`
 * and says to choose there).
 */

/** The study questions (the "Not sure which fits?" side trip). */
const STUDY_ROUTE = FLOW_ROUTES.study

/** The Models page (the import's landing; spelled here because txrintake
 *  declares no dependency on txrmodels — the route is the shell's own). */
const MODELS_ROUTE = '/models'

/** The page's frame host. */
const PAGE_ROOT: CSSProperties = {
  height: '100%',
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
}

/** The body region's content (the page's scrollable body). */
const PAGE_CONTAINER: CSSProperties = {
  boxSizing: 'border-box',
  padding: '40px 48px 28px',
  maxWidth: 1180,
  margin: '0 auto',
  width: '100%',
  display: 'flex',
  flexDirection: 'column',
  gap: 28,
}

const STEP_LINE: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--txr-brand)',
}

const TITLE: CSSProperties = {
  margin: '2px 0 6px',
  fontFamily: "'Source Serif 4', Georgia, serif",
  fontWeight: 600,
  fontSize: 28,
  lineHeight: 1.2,
}

const INTRO: CSSProperties = {
  margin: 0,
  color: 'var(--txr-text-2)',
  maxWidth: '62ch',
}

/** The card grid + the one shared card body (board Start.dc.html). */
const CARD_GRID: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 18,
}

const CARD_BASE: CSSProperties = {
  flex: '1 1 340px',
  minWidth: 0,
  boxSizing: 'border-box',
  padding: '24px 26px',
  borderRadius: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  background: 'var(--txr-surface)',
}

/** Every card: one look, no highlighted card. */
const CARD: CSSProperties = {
  ...CARD_BASE,
  border: '1px solid var(--txr-border)',
}

const CARD_EYEBROW: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--txr-muted)',
}

const CARD_TITLE: CSSProperties = {
  margin: 0,
  fontFamily: "'Source Serif 4', Georgia, serif",
  fontWeight: 600,
  fontSize: 22,
  lineHeight: 1.25,
}

const CARD_BODY: CSSProperties = {
  margin: 0,
  color: 'var(--txr-text-2)',
}

const CARD_BULLETS: CSSProperties = {
  margin: 0,
  paddingLeft: 20,
  // qa-fixes ITEM-6 L2: the board's dots — the kit's global reset removed
  // `list-style` and the cards read as indented paragraphs.
  listStyle: 'disc',
  color: 'var(--txr-text-2)',
  fontSize: 14.5,
}

const CARD_BULLET: CSSProperties = { margin: '3px 0' }

/** The one skeleton line's look (a grey bar the kit's Skeleton paints). */
const SKELETON_LINE: CSSProperties = { width: '100%', height: 14 }

/** The "Recommended to start" pill (board inline span; var(--txr-success-soft)/var(--txr-success-ink)).
 *  On exactly one card: predict when a ready-made model exists, otherwise "Learn from my data". */
const RECOMMENDED_BADGE: CSSProperties = {
  fontSize: 12.5,
  padding: '2px 10px',
  borderRadius: 999,
  background: 'var(--txr-success-soft)',
  color: 'var(--txr-success-ink)',
  marginLeft: 8,
  whiteSpace: 'nowrap',
}

/** A card's actions: the button row, then the "Use example" message (if any)
 *  as the last row, at the card's full width. `marginTop: auto` keeps the
 *  buttons at the card's bottom. */
const CARD_ACTIONS: CSSProperties = {
  marginTop: 'auto',
  paddingTop: 10,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
}

const CARD_BUTTON_ROW: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  // Space between the card's buttons; they stay on one row.
  gap: 10,
}

const PRIMARY_BUTTON: CSSProperties = {
  borderRadius: 8,
  background: 'var(--txr-brand)',
  color: 'var(--txr-on-brand)',
  fontWeight: 700,
}

/** The banner (board copy + the board's two affordances). */
const BANNER: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 14,
  alignItems: 'baseline',
  padding: '14px 18px',
  border: '1px solid var(--txr-border-subtle)',
  borderRadius: 10,
  background: 'var(--txr-bg)',
  color: 'var(--txr-text-2)',
  fontSize: 14,
}

const BANNER_SPACER: CSSProperties = { flexGrow: 1 }

// qa-fixes ITEM-6 L1: the button carried the kit link's padding (the
// 11 px indent + the extra top gap vs the paragraph above it); it now
// renders flush with the banner's line.
/** The banner's study link (qa-fixes ITEM-6 L1: flush with the line). */
const EXAMPLE_LINK: CSSProperties = { padding: 0, color: 'var(--txr-brand)', fontWeight: 600 }

/** The one-line web notice (DEC-12): origin read at runtime, never a literal. */
const WEB_URL_NOTICE: CSSProperties = {
  margin: '0 0 -8px',
  color: 'var(--txr-muted)',
  fontSize: 13.5,
}

/**
 * A card's actions: the card's own button, "Use example" and (state B of the
 * predict card) "Open a model file" on one row, and under that row whatever
 * "Use example" has to say (the confirm question, the progress line, the
 * error), across the card. Inside the row a long message would widen the
 * "Use example" slot and stretch its button.
 *
 * Demo mode (demo-mode ITEM-6): the audit's "the 'Add my data' / 'Add the
 * patients to predict' buttons read 'Use the example data'; the qa-fixes3
 * 'Use example' buttons are the primary action" — the plain CTA is
 * replaced by the use-example button (the primary look + the audit's
 * label), and the one button owns the card's flow action.
 */
function CardActions({
  path,
  primary,
  demo = false,
  useExamplePrimary = false,
  openFile = null,
}: {
  path: IntakeIntent
  /** The card's own plain CTA (absent in demo and in the predict card's state B). */
  primary?: ReactNode | null
  demo?: boolean
  useExamplePrimary?: boolean
  openFile?: ReactNode
}) {
  return (
    <TxrUseExampleButton
      path={path}
      label={demo ? DEMO_START_PRIMARY : undefined}
      style={useExamplePrimary || demo ? PRIMARY_BUTTON : undefined}
      layout={({ action, message }) => (
        <div data-testid={`txr-intake-start-card-${path}-actions`} style={CARD_ACTIONS}>
          <div data-testid={`txr-intake-start-card-${path}-buttons`} style={CARD_BUTTON_ROW}>
            {primary}
            {action}
            {openFile}
          </div>
          {message}
        </div>
      )}
    />
  )
}

export function StartPage() {
  const { count } = useRunnableMethodCount()
  // The ONE counts source of the two cards (see the header): the lab
  // catalogue count and the store's `run` / `imported` counts. `null` =
  // loading or failed; `failed` is the "never show state B" flag.
  const { lab, saved, imported, failed } = usePredictModelCounts()
  const { isDemo } = useAppMode()
  const navigate = useNavigate()
  // R2-G1: the tab/title byte is the page's own h1.
  useDocumentTitle('What do you want to do?')
  // Every path that starts here goes back here from its first step (the step trail).
  useEffect(() => {
    beginPath('/')
  }, [])

  // The import picker of the predict card's "Open a model file" (round 1):
  // the picker opens in place; a successful import lands on the Models page.
  const importFile = useModelFileImport({
    onImported: () => navigate(MODELS_ROUTE),
  })

  // The three counts' state: some model exists (state A), none anywhere and
  // all three KNOWN (state B), or still loading (skeletons — never flash B).
  const someModel =
    (lab !== null && lab > 0) || (saved !== null && saved > 0) || (imported !== null && imported > 0)
  const allKnown = lab !== null && saved !== null && imported !== null
  const noModelAnywhere = allKnown && lab === 0 && saved === 0 && imported === 0
  // Demo mode: the predict card is always state A (the demo has its
  // recorded lab models); the counts state never shows B there.
  const predictStateB = !isDemo && noModelAnywhere
  const predictLoading = !isDemo && !failed && !someModel && !noModelAnywhere
  // The badge: on the predict card when the lab catalogue has a model,
  // otherwise on "Learn from my data" (also while loading or failed).
  const recommended: IntakeIntent = lab !== null && lab > 0 ? 'predict' : 'train'

  /** The card path picker: the registered `flow.startPath` sets the intent,
   *  then starts the flow it leads to (train → the files step, predict → N). */
  const pickPath = useCallback((intent: IntakeIntent) => {
    void runAction('flow.startPath', { intent })
  }, [])

  const webUrlUsable =
    typeof window !== 'undefined' &&
    window.location.protocol === 'http:' &&
    import.meta.env.DEV

  return (
    <div role="main" data-testid="txr-intake-start" style={PAGE_ROOT}>
      <PageFrame
        body={
          <ScrollRegion label="Start">
            <div className="txr-intake-page-body" style={PAGE_CONTAINER}>
              <div>
                <div style={STEP_LINE}>Step 1 of 4</div>
                <h1 style={TITLE}>What do you want to do?</h1>
                <p style={INTRO}>
                  Pick the way that fits what you have; you can change your mind later.
                </p>
              </div>

              <div style={CARD_GRID}>
                <section style={CARD} data-testid="txr-intake-start-card-train">
                  <div style={CARD_EYEBROW}>
                    {noModelAnywhere
                      ? 'Start here: train your first models'
                      : 'Most flexible'}
                  </div>
                  <h2 style={CARD_TITLE}>
                    Learn from my data
                    {recommended === 'train' ? (
                      <span data-testid="txr-intake-start-card-train-badge" style={RECOMMENDED_BADGE}>
                        Recommended to start
                      </span>
                    ) : null}
                  </h2>
                  <p style={CARD_BODY}>
                    {noModelAnywhere
                      ? 'Train the methods on your patients with known outcomes and save them as models. Then predict new patients with them.'
                      : 'Train the methods on your own patients with known outcomes, then predict new patients. Choose what to predict — progression or death within a chosen horizon — and run the methods that fit your file.'}
                  </p>
                  <ul style={CARD_BULLETS}>
                    <li style={CARD_BULLET}>
                      Needs patients with outcomes (progression or death times)
                    </li>
                    <li style={CARD_BULLET}>
                      {count !== null
                        ? `${count} methods, with the time each will take`
                        : 'Methods, with the time each will take'}
                    </li>
                    <li style={CARD_BULLET}>Save the trained models to reuse them</li>
                  </ul>
                  <CardActions
                    path="train"
                    demo={isDemo}
                    useExamplePrimary={isDemo}
                    primary={
                      isDemo ? null : (
                        <Button
                          data-testid="txr-intake-start-card-train-cta"
                          style={PRIMARY_BUTTON}
                          onClick={() => pickPath('train')}
                        >
                          Add my data
                        </Button>
                      )
                    }
                  />
                </section>

                <section style={CARD} data-testid="txr-intake-start-card-predict">
                  {predictLoading && !isDemo ? (
                    <>
                      <div style={CARD_EYEBROW}>
                        <Skeleton style={{ width: 140, height: 12 }} />
                      </div>
                      <h2 style={CARD_TITLE}>
                        Predict new patients
                        {recommended === 'predict' ? (
                          <span data-testid="txr-intake-start-card-predict-badge" style={RECOMMENDED_BADGE}>
                            Recommended to start
                          </span>
                        ) : null}
                      </h2>
                      <div style={CARD_BODY}>
                        <Skeleton style={SKELETON_LINE} />
                        <Skeleton style={{ ...SKELETON_LINE, marginTop: 6 }} />
                        <Skeleton style={{ ...SKELETON_LINE, marginTop: 6 }} />
                      </div>
                      <ul style={CARD_BULLETS}>
                        <li style={CARD_BULLET}><Skeleton style={SKELETON_LINE} /></li>
                        <li style={CARD_BULLET}><Skeleton style={SKELETON_LINE} /></li>
                        <li style={CARD_BULLET}><Skeleton style={SKELETON_LINE} /></li>
                      </ul>
                      <CardActions
                        path="predict"
                        demo={isDemo}
                        primary={
                          <Button
                            data-testid="txr-intake-start-card-predict-cta"
                            style={PRIMARY_BUTTON}
                            onClick={() => pickPath('predict')}
                          >
                            Add the patients to predict
                          </Button>
                        }
                      />
                    </>
                  ) : predictStateB ? (
                    <>
                      <div style={CARD_EYEBROW}>Uses a trained model</div>
                      <h2 style={CARD_TITLE}>Predict new patients</h2>
                      <p style={CARD_BODY}>
                        Predicts new patients with a trained model: a ready-made one from the
                        lab, one you saved, or one opened from a file. Models you train and save
                        with <b>Learn from my data</b> appear here.
                      </p>
                      <Alert
                        data-testid="txr-intake-start-card-predict-note"
                        tone="info"
                        title="Use example first trains a few example models on the example patients (usually under a minute; the first time also downloads the methods), then predicts the example's new patients with them."
                      />
                      <ul style={CARD_BULLETS}>
                        <li style={CARD_BULLET}>
                          Or open a model file someone gave you
                        </li>
                      </ul>
                      <CardActions
                        path="predict"
                        demo={isDemo}
                        useExamplePrimary
                        openFile={
                          <Button
                            data-testid="txr-intake-start-card-predict-open-file"
                            style={{ ...PRIMARY_BUTTON, background: 'var(--txr-surface)', color: 'var(--txr-text)', border: '1px solid var(--txr-border)' }}
                            onClick={() => void runAction('models.openModelFile', {})}
                          >
                            Open a model file
                          </Button>
                        }
                      />
                    </>
                  ) : (
                    <>
                      <div style={CARD_EYEBROW}>Uses a trained model</div>
                      <h2 style={CARD_TITLE}>
                        Predict new patients
                        {recommended === 'predict' ? (
                          <span data-testid="txr-intake-start-card-predict-badge" style={RECOMMENDED_BADGE}>
                            Recommended to start
                          </span>
                        ) : null}
                      </h2>
                      <p style={CARD_BODY}>
                        Add the blood measurements of the patients you want predictions for,
                        then pick any models that can run on them: ready-made models from the
                        lab, models you saved, or models opened from a file.
                      </p>
                      <ul style={CARD_BULLETS}>
                        <li style={CARD_BULLET}>
                          Works with a small cohort, and with no outcomes
                        </li>
                        <li style={CARD_BULLET}>
                          The app checks your file and shows which models can run
                        </li>
                        <li style={CARD_BULLET}>
                          Mix a lab model and your own in the same run
                        </li>
                      </ul>
                      <CardActions
                        path="predict"
                        demo={isDemo}
                        useExamplePrimary={isDemo}
                        primary={
                          isDemo ? null : (
                            <Button
                              data-testid="txr-intake-start-card-predict-cta"
                              style={PRIMARY_BUTTON}
                              onClick={() => pickPath('predict')}
                            >
                              Add the patients to predict
                            </Button>
                          )
                        }
                      />
                    </>
                  )}
                </section>
              </div>

              {/* native-control-ok: the file input is invisible; the visible affordance is <Button> */}
              <input
                {...importFile.inputProps}
                style={{ display: 'none' }}
                aria-hidden="true"
                tabIndex={-1}
                data-testid="txr-intake-start-open-model-file-input"
              />
              {importFile.error !== null ? (
                <Alert
                  data-testid="txr-intake-start-open-model-file-error"
                  tone="error"
                  title={importFile.error}
                />
              ) : null}

              <div style={BANNER}>
                <span>
                  Not sure which fits?{' '}
                  <Link data-testid="txr-intake-start-unsure" style={EXAMPLE_LINK} to={STUDY_ROUTE}>
                    Answer a few questions about your study on the next screen
                  </Link>
                  : we show what each way needs from you.
                </span>
                <span style={BANNER_SPACER} />
                <span data-testid="txr-intake-start-example-hint">
                  {isDemo ? (
                    DEMO_START_HINT
                  ) : (
                    <>
                      Prefer to try it first? <b>Use example</b> on any card fills the whole flow with
                      the example data — replace it with your own files at any time.
                    </>
                  )}
                </span>
              </div>

              {webUrlUsable ? (
                <div style={WEB_URL_NOTICE} data-testid="txr-intake-web-url">
                  This app is also available at {window.location.origin}
                </div>
              ) : null}
            </div>
          </ScrollRegion>
        }
      />
    </div>
  )
}
