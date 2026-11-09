import { useCallback, useState } from 'react'
import type { CSSProperties } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Button } from '@ziee/kit'
import { ApiClient } from '@/api-client'
import { parseCsvText } from '@/lib/txr-files/csv'
import type { FileTableKind, ParsedTable } from '@/lib/txr-files/types'
import { TxrIntake } from '../stores/TxrIntake.store'
import { useRunnableMethodCount } from '../data/useRunnableMethodCount'
import type { IntakeIntent, LoadedFile } from '../types'

/**
 * Screen A — Start (board Start.dc.html): the three FLOW paths as cards
 * (Path 1 pretrained, Path 2 learn from my data, Path 3 saved models), the
 * "Not sure which fits?" banner with "Try the example data", and the
 * dev/web web-URL notice (DEC-12).
 *
 * Board-copy rule (DEC-13): board wording is used verbatim where it is a
 * label or behavior; every NUMBER on the board is a design example, never
 * data. The learn card's count is the LIVE runnable count (CONS-UI-INTAKE-3
 * via `useRunnableMethodCount`); the pretrained + saved cards carry no count
 * clauses until their nodes exist (pretrained-catalogue wave 4, model-store
 * wave 3 — no edge; OWNER-7, DEC-6).
 *
 * Intent navigation (PROV-UI-INTAKE-1 + DEC-20): each card's button sets the
 * intent FIRST (the store's `setIntent` maps it to the flow's mode) and then
 * navigates to the intake route the path starts on — pretrained/reuse →
 * `/predict-files` (N), train → `/study` (B). "Try the example data" sets
 * intent `train`, adopts the two example files (CONS-UI-INTAKE-6, DEC-20)
 * and lands on `/files` with the C screen's files already in the store.
 */

/** The intake's own route literals (the module route table is the source). */
const STUDY_ROUTE = '/study'
const FILES_ROUTE = '/files'
const PREDICT_FILES_ROUTE = '/predict-files'

const PAGE_CONTAINER: CSSProperties = {
  flexGrow: 1,
  boxSizing: 'border-box',
  padding: '40px 48px',
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

/** The highlighted card (Path 1) — the 2 px accent border distinguishes it. */
const CARD_ACCENT: CSSProperties = {
  ...CARD_BASE,
  border: '2px solid var(--txr-brand)',
}

/** The two plain cards (Paths 2 and 3). */
const CARD_PLAIN: CSSProperties = {
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

/** The "Recommended to start" pill (board inline span; var(--txr-success-soft)/var(--txr-success-ink)). */
const RECOMMENDED_BADGE: CSSProperties = {
  fontSize: 12.5,
  padding: '2px 10px',
  borderRadius: 999,
  background: 'var(--txr-success-soft)',
  color: 'var(--txr-success-ink)',
  marginLeft: 8,
  whiteSpace: 'nowrap',
}

const CARD_BUTTON_ROW: CSSProperties = {
  marginTop: 'auto',
  paddingTop: 10,
  display: 'flex',
  alignItems: 'center',
}

const PRIMARY_BUTTON: CSSProperties = {
  borderRadius: 8,
  background: 'var(--txr-brand)',
  color: 'var(--txr-on-brand)',
  fontWeight: 700,
}

const OUTLINE_BUTTON: CSSProperties = {
  borderRadius: 8,
  background: 'var(--txr-surface)',
  color: 'var(--txr-text)',
  fontWeight: 600,
  border: '1px solid var(--txr-border)',
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
const EXAMPLE_LINK: CSSProperties = { padding: 0, color: 'var(--txr-brand)', fontWeight: 600 }

/** The one-line web notice (DEC-12): origin read at runtime, never a literal. */
const WEB_URL_NOTICE: CSSProperties = {
  margin: '0 0 -8px',
  color: 'var(--txr-muted)',
  fontSize: 13.5,
}

/**
 * One example CSV through the provider asset endpoint (CONS-UI-INTAKE-6) and
 * PROV-FV-7's browser decode — the same bytes the "Download the full example"
 * link serves, adopted as the C screen's patients + measurements files
 * (DEC-20). The generated response type for the text/csv body is `void` (the
 * openapi schema has no JSON body — a provider dtype artifact, DRIFT-1 ITEM-4
 * #3); the shared transport's parse switch returns the TEXT of a `text/*`
 * body, so this cast at the one seam is the consumer side, and the byte guard
 * keeps a bodiless response loud instead of a silent empty table. The
 * inspect/validate pass that turns these into card facts is the C-screen flow
 * (ITEM-6's `lib/flow.ts` + FilesPage) — this loader only parses + adopts.
 */
async function fetchExampleTable(kind: FileTableKind): Promise<ParsedTable> {
  const body = (await ApiClient.FileValidation.example({ kind })) as unknown as string
  if (typeof body !== 'string' || body.length === 0) {
    throw new Error(`the example ${kind} file came back empty`)
  }
  return parseCsvText(body, { kind }, `${kind}_example.csv`)
}

/** The adopted-file shell: the decode only — card facts come from the flows. */
function loadedFrom(table: ParsedTable): LoadedFile {
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

export function StartPage() {
  const navigate = useNavigate()
  const { count } = useRunnableMethodCount()
  const [exampleBusy, setExampleBusy] = useState(false)
  const [exampleError, setExampleError] = useState<string | null>(null)

  /** The card path picker: set the intent, then start the flow it leads to. */
  const pickPath = useCallback(
    (intent: IntakeIntent) => {
      TxrIntake.setIntent(intent)
      if (intent === 'train') {
        navigate(STUDY_ROUTE)
      } else {
        navigate(PREDICT_FILES_ROUTE)
      }
    },
    [navigate],
  )

  /** "Try the example data" (DEC-20): train intent + both example files → C. */
  const tryExampleData = useCallback(async () => {
    if (exampleBusy) return
    setExampleBusy(true)
    setExampleError(null)
    try {
      const [patients, measurements] = await Promise.all([
        fetchExampleTable('patients'),
        fetchExampleTable('measurements'),
      ])
      TxrIntake.setIntent('train')
      TxrIntake.adoptFile('patients', loadedFrom(patients))
      TxrIntake.adoptFile('measurements', loadedFrom(measurements))
      // ITEM-6 F6: the C screen announces the example (the old flow landed
      // on /files with both cards filled and no word about what was loaded).
      TxrIntake.setExampleLoaded(true)
      navigate(FILES_ROUTE)
    } catch {
      setExampleError('The example files could not be loaded. Try again.')
    } finally {
      setExampleBusy(false)
    }
  }, [exampleBusy, navigate])

  const webUrlUsable =
    typeof window !== 'undefined' &&
    window.location.protocol === 'http:' &&
    import.meta.env.DEV

  return (
    <div role="main" style={PAGE_CONTAINER}>
      <div>
        <div style={STEP_LINE}>Step 1 of 4</div>
        <h1 style={TITLE}>What do you want to do?</h1>
        <p style={INTRO}>
          Everything runs on this computer. Pick the way that fits what you have; you can change
          your mind later.
        </p>
      </div>

      <div style={CARD_GRID}>
        <section style={CARD_ACCENT} data-testid="txr-intake-start-card-pretrained">
          <div style={CARD_EYEBROW}>Quickest</div>
          <h2 style={CARD_TITLE}>
            Predict with a pretrained model
            <span style={RECOMMENDED_BADGE}>Recommended to start</span>
          </h2>
          <p style={CARD_BODY}>
            Add the blood measurements of the patients you want predictions for. We show which
            pretrained models can run on them, and you pick as many as you like.
          </p>
          <ul style={CARD_BULLETS}>
            <li style={CARD_BULLET}>Works with a small cohort, and with no outcomes</li>
            <li style={CARD_BULLET}>
              The app checks your file and shows which models can run
            </li>
            <li style={CARD_BULLET}>
              Each model shows where it was learned and how well it transferred to other cohorts
            </li>
          </ul>
          <div style={CARD_BUTTON_ROW}>
            <Button
              data-testid="txr-intake-start-card-pretrained-cta"
              style={PRIMARY_BUTTON}
              onClick={() => pickPath('pretrained')}
            >
              Add the patients to predict
            </Button>
          </div>
        </section>

        <section style={CARD_PLAIN} data-testid="txr-intake-start-card-train">
          <div style={CARD_EYEBROW}>Most flexible</div>
          <h2 style={CARD_TITLE}>Learn from my data</h2>
          <p style={CARD_BODY}>
            Train the methods on your own patients with known outcomes, then predict new patients.
            Select as many methods as you like.
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
          <div style={CARD_BUTTON_ROW}>
            <Button
              data-testid="txr-intake-start-card-train-cta"
              style={OUTLINE_BUTTON}
              onClick={() => pickPath('train')}
            >
              Add my data
            </Button>
          </div>
        </section>

        <section style={CARD_PLAIN} data-testid="txr-intake-start-card-reuse">
          <div style={CARD_EYEBROW}>Repeat a past analysis</div>
          <h2 style={CARD_TITLE}>Use a model I saved</h2>
          <p style={CARD_BODY}>
            Add the patients to predict, then pick any of the models you trained here before, one
            or many. No need to upload the training data again.
          </p>
          <ul style={CARD_BULLETS}>
            <li style={CARD_BULLET}>
              Checks that the new patients have the markers the model needs
            </li>
          </ul>
          <div style={CARD_BUTTON_ROW}>
            {/* qa-fixes ITEM-6 L3: the board labels BOTH flows "Add the
                patients to predict" — the pretrained card's words — so the
                saved-model path was indistinguishable at a glance; the
                plain sentence names the flow this button starts. */}
            <Button
              data-testid="txr-intake-start-card-reuse-cta"
              style={OUTLINE_BUTTON}
              onClick={() => pickPath('reuse')}
            >
              Predict with a model I saved
            </Button>
          </div>
        </section>
      </div>

      <div style={BANNER}>
        <span>
          Not sure which fits?{' '}
          <Link data-testid="txr-intake-start-unsure" style={EXAMPLE_LINK} to={STUDY_ROUTE}>
            Answer a few questions about your study on the next screen
          </Link>
          : we show what each way needs from you.
        </span>
        <span style={BANNER_SPACER} />
        <Button
          data-testid="txr-intake-start-example"
          variant="link"
          style={EXAMPLE_LINK}
          loading={exampleBusy}
          onClick={() => void tryExampleData()}
        >
          Try the example data
        </Button>
      </div>

      {exampleError !== null ? (
        <div role="alert" style={{ color: 'var(--txr-danger)', fontSize: 13.5 }}>
          {exampleError}
        </div>
      ) : null}

      {webUrlUsable ? (
        <div style={WEB_URL_NOTICE} data-testid="txr-intake-web-url">
          This app is also available at {window.location.origin}
        </div>
      ) : null}
    </div>
  )
}
