import { useCallback, useState } from 'react'
import type { CSSProperties } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useStore } from 'zustand'
import { Button, Checkbox, Select, Skeleton } from '@ziee/kit'
import { useTxrIntakeStore } from '../stores/TxrIntake.store'
import { useMarkers } from '../data/useMarkers'
import { useStudyPreview } from '../data/useStudyPreview'
import {
  BEFORE_TREATMENT_OPTIONS,
  DISEASE_OPTIONS,
  DRAWS_OPTIONS,
  EXCLUDED_LIST_LIMIT,
  LAST_DRAW_OPTIONS,
  OUTCOME_OPTIONS,
  TREATMENT_OPTIONS,
  leftOutHeading,
  someFitLine,
} from '../lib/format'
import { descriptiveSentence } from '../lib/preview'
import type { DiseaseId, OutcomeId, TreatmentId } from '../types'

/**
 * Screen B — Your study (board Criteria.dc.html, ITEM-5): the six question
 * groups (disease, treatment, outcome, marker groups, before-treatment /
 * draws / last draw) and the live "N of M methods fit" panel with the
 * excluded list, rendered from the structured preview response
 * (CONS-UI-INTAKE-2) through the CONS-UI-INTAKE-9 reason formatters.
 *
 * INV-1: every answer change re-runs the fit computation — the page writes
 * each answer straight to the `TxrIntake` store (`patchStudy`), and the
 * panel hook keys its request on the answers' CONTENT with a 200 ms debounce
 * (a burst costs one eligibility call; the stale-response guard keeps the
 * panel honest). The last-draw answer is ALSO the engine's decision-day
 * value, so it rides `patchParameters` (one value, three uses — DEC-5).
 *
 * Board-copy rule (DEC-13): every label is board-verbatim; the panel's
 * numbers are COMPUTED from the provider response (fit count, left-out
 * count, "Show all N") — none of the boards' example counts is hardcoded.
 *
 * The "N pretrained models match <disease>" note is NOT rendered: the
 * pretrained catalogue is wave 4 (OWNER-2 / DEC-7) and the published-files
 * rule forbids copy that promises what is not there — `ui-models` re-adds the note with real
 * data on this same route.
 */

const FILES_ROUTE = '/files'
const PREDICT_FILES_ROUTE = '/predict-files'

const PAGE_CONTAINER: CSSProperties = {
  flexGrow: 1,
  boxSizing: 'border-box',
  padding: '40px 48px',
  maxWidth: 1280,
  margin: '0 auto',
  width: '100%',
}

/** The board's two-column main (left questions, right grey panel column). */
const COLUMNS: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'flex-start',
}

const LEFT_COLUMN: CSSProperties = {
  flex: '1 1 560px',
  minWidth: 0,
  boxSizing: 'border-box',
  paddingRight: 36,
  display: 'flex',
  flexDirection: 'column',
}

const PANEL_COLUMN: CSSProperties = {
  flex: '1 1 460px',
  minWidth: 0,
  boxSizing: 'border-box',
  padding: '24px 32px',
  borderRadius: 12,
  background: '#fbfaf8',
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
}

const STEP_LINE: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: '#1d4e89',
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
  color: '#3a3a3a',
  maxWidth: '62ch',
}

/** One question group block (the board's bordered sections). */
const QUESTION_GROUP: CSSProperties = {
  padding: '16px 0',
  borderBottom: '1px solid #e7e5e0',
}

const QUESTION_LABEL: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: '#5e5e5e',
  marginBottom: 10,
}

const FIELD_ROW: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 18,
}

const FIELD: CSSProperties = { display: 'block' }

const FIELD_LABEL: CSSProperties = {
  display: 'block',
  fontWeight: 600,
  marginBottom: 6,
}

const GROUP_CHECKBOX: CSSProperties = { padding: '3px 0' }

/** The outcome pills (board: 999-radius buttons, one pressed at a time). */
const PILLS: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8 }

const PILL: CSSProperties = {
  borderRadius: 999,
  padding: '5px 12px',
  fontSize: 13.5,
  fontWeight: 500,
  border: '1px solid #cfcdc7',
  background: '#ffffff',
  color: '#3a3a3a',
}

const PILL_SELECTED: CSSProperties = {
  ...PILL,
  border: '1px solid #1d4e89',
  background: '#e8eef6',
  color: '#143a68',
  fontWeight: 600,
}

const BUTTON_ROW: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 14,
  paddingTop: 20,
}

const PRIMARY_BUTTON: CSSProperties = {
  borderRadius: 8,
  background: '#1d4e89',
  color: '#ffffff',
  fontWeight: 700,
}

const OUTLINE_BUTTON: CSSProperties = {
  borderRadius: 8,
  background: '#ffffff',
  color: '#141414',
  fontWeight: 600,
  border: '1px solid #cfcdc7',
}

/** The panel's big count line (the board's big-number + suffix design). */
const PANEL_COUNT: CSSProperties = {
  fontFamily: "'Source Serif 4', Georgia, serif",
  fontSize: 40,
  fontWeight: 600,
  lineHeight: 1,
}

const PANEL_SUFFIX: CSSProperties = {
  fontSize: 20,
  color: '#5e5e5e',
  fontWeight: 400,
}

const PANEL_SENTENCE: CSSProperties = {
  margin: '4px 0 0',
  color: '#3a3a3a',
  fontSize: 14,
}

const PANEL_SOME_LINE: CSSProperties = {
  margin: 0,
  color: '#3a3a3a',
  fontSize: 13.5,
}

const PANEL_ERROR: CSSProperties = { margin: 0, color: '#b3261e', fontSize: 13.5 }

/** The "What you will upload" box (board: bordered white card). */
const UPLOAD_BOX: CSSProperties = {
  padding: '14px 16px',
  border: '1px solid #cfcdc7',
  borderRadius: 10,
  background: '#ffffff',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
}

const UPLOAD_TITLE: CSSProperties = { fontWeight: 700, margin: 0 }

const UPLOAD_LIST: CSSProperties = {
  margin: 0,
  paddingLeft: 18,
  fontSize: 14.5,
}

const LINK: CSSProperties = { fontSize: 13.5, color: '#1d4e89', fontWeight: 600 }

const EXCLUDED_HEADING: CSSProperties = { fontWeight: 700, marginBottom: 4 }

const EXCLUDED_LIST: CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: 'none',
}

const EXCLUDED_LI: CSSProperties = {
  display: 'flex',
  gap: 10,
  padding: '5px 0',
  borderBottom: '1px solid #efede8',
}

const EXCLUDED_ID: CSSProperties = {
  fontFamily: "'Source Code Pro', monospace",
  fontSize: 12.5,
  minWidth: 190,
  wordBreak: 'break-all',
}

const EXCLUDED_REASON: CSSProperties = { color: '#5e5e5e', fontSize: 13.5 }

export function StudyPage() {
  const navigate = useNavigate()
  const study = useStore(useTxrIntakeStore, s => s.study)
  const intent = useStore(useTxrIntakeStore, s => s.intent)
  const mode = useStore(useTxrIntakeStore, s => s.mode)
  const patchStudy = useStore(useTxrIntakeStore, s => s.patchStudy)
  const patchParameters = useStore(useTxrIntakeStore, s => s.patchParameters)
  const { groups, loading: groupsLoading, error: groupsError } = useMarkers()
  const panel = useStudyPreview(study, groups)
  const [showAllExcluded, setShowAllExcluded] = useState(false)

  /** One checkbox toggle: the answer map grows/shrinks explicitly (DEC-5). */
  const setGroup = useCallback(
    (groupId: string, checked: boolean) => {
      patchStudy({ markerGroups: { ...(study.markerGroups ?? {}), [groupId]: checked } })
    },
    [patchStudy, study.markerGroups],
  )

  /** The last-draw answer is the engine's decision day (one value, DEC-5). */
  const setLastDrawDay = useCallback(
    (value: string) => {
      const day = Number(value) as 28 | 42 | 56 | 84
      patchStudy({ lastDrawDay: day })
      patchParameters({ decision_day: day })
    },
    [patchStudy, patchParameters],
  )

  /** Continue / Skip: the files screen of THIS flow (train → C, else → N). */
  const continueFlow = useCallback(() => {
    navigate(intent === 'train' ? FILES_ROUTE : PREDICT_FILES_ROUTE)
  }, [navigate, intent])

  const excluded = panel.excluded
  const shownExcluded = showAllExcluded ? excluded : excluded.slice(0, EXCLUDED_LIST_LIMIT)
  const hasMoreExcluded = excluded.length > EXCLUDED_LIST_LIMIT

  return (
    <div role="main" style={PAGE_CONTAINER} data-testid="txr-intake-study">
      <div style={COLUMNS}>
        <section style={LEFT_COLUMN}>
          <div>
            <div style={STEP_LINE}>Step 2 of 4</div>
            <h1 style={TITLE}>Tell us about your study</h1>
            <p style={INTRO}>
              So you know what to expect to upload, and which methods can run. All optional: skip
              any question and we check your files instead.
            </p>
          </div>

          <div style={QUESTION_GROUP}>
            <div style={QUESTION_LABEL}>Patients</div>
            <div style={FIELD_ROW}>
              <div style={FIELD}>
                <span style={FIELD_LABEL}>Disease</span>
                <Select
                  id="txr-intake-study-disease"
                  data-testid="txr-intake-study-disease"
                  aria-label="Disease"
                  value={study.disease ?? undefined}
                  onChange={v => patchStudy({ disease: v as DiseaseId })}
                  placeholder="Choose a disease…"
                  options={DISEASE_OPTIONS.map(o => ({ label: o.label, value: o.value }))}
                />
              </div>
              <div style={FIELD}>
                <span style={FIELD_LABEL}>Treatment</span>
                <Select
                  id="txr-intake-study-treatment"
                  data-testid="txr-intake-study-treatment"
                  aria-label="Treatment"
                  value={study.treatment ?? undefined}
                  onChange={v => patchStudy({ treatment: v as TreatmentId })}
                  placeholder="Choose a treatment…"
                  options={TREATMENT_OPTIONS.map(o => ({ label: o.label, value: o.value }))}
                />
              </div>
            </div>
          </div>

          <div style={QUESTION_GROUP}>
            <div style={QUESTION_LABEL}>What you want to predict</div>
            <div style={PILLS} role="group" aria-label="What you want to predict">
              {OUTCOME_OPTIONS.map(option => {
                const selected = study.outcome === option.value
                return (
                  <Button
                    key={option.value}
                    data-testid={`txr-intake-study-outcome-${option.value}`}
                    variant="outline"
                    aria-pressed={selected}
                    style={selected ? PILL_SELECTED : PILL}
                    onClick={() =>
                      patchStudy({ outcome: selected ? null : (option.value as OutcomeId) })
                    }
                  >
                    {option.label}
                  </Button>
                )
              })}
            </div>
          </div>

          <div style={QUESTION_GROUP}>
            <div style={QUESTION_LABEL}>Blood markers you measured</div>
            {groupsLoading ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <Skeleton style={{ width: 300, height: 18 }} />
                <Skeleton style={{ width: 260, height: 18 }} />
                <Skeleton style={{ width: 280, height: 18 }} />
              </div>
            ) : groupsError !== null ? (
              <div role="alert" style={PANEL_ERROR}>
                {groupsError}
              </div>
            ) : (
              groups.map(group => (
                <div key={group.id} style={GROUP_CHECKBOX}>
                  <Checkbox
                    data-testid={`txr-intake-study-group-${group.id}`}
                    label={group.display_name}
                    checked={study.markerGroups?.[group.id] === true}
                    onCheckedChange={checked => setGroup(group.id, checked)}
                  />
                </div>
              ))
            )}
          </div>

          <div style={QUESTION_GROUP}>
            <div style={QUESTION_LABEL}>When you drew blood</div>
            <div style={FIELD_ROW}>
              <div style={FIELD}>
                <span style={FIELD_LABEL}>Before treatment</span>
                <Select
                  id="txr-intake-study-before"
                  data-testid="txr-intake-study-before"
                  aria-label="Before treatment"
                  value={study.beforeTreatment ?? undefined}
                  onChange={v =>
                    patchStudy({ beforeTreatment: v as 'always' | 'sometimes' })
                  }
                  placeholder="Choose…"
                  options={BEFORE_TREATMENT_OPTIONS.map(o => ({ label: o.label, value: o.value }))}
                />
              </div>
              <div style={FIELD}>
                <span style={FIELD_LABEL}>Draws during treatment</span>
                <Select
                  id="txr-intake-study-draws"
                  data-testid="txr-intake-study-draws"
                  aria-label="Draws during treatment"
                  value={study.drawsDuringTreatment !== null ? String(study.drawsDuringTreatment) : undefined}
                  onChange={v => patchStudy({ drawsDuringTreatment: Number(v) as 1 | 2 | 4 })}
                  placeholder="Choose…"
                  options={DRAWS_OPTIONS.map(o => ({ label: o.label, value: String(o.value) }))}
                />
              </div>
              <div style={FIELD}>
                <span style={FIELD_LABEL}>Last draw you will use</span>
                <Select
                  id="txr-intake-study-last-draw"
                  data-testid="txr-intake-study-last-draw"
                  aria-label="Last draw you will use"
                  value={study.lastDrawDay !== null ? String(study.lastDrawDay) : undefined}
                  onChange={setLastDrawDay}
                  placeholder="Choose…"
                  options={LAST_DRAW_OPTIONS.map(o => ({ label: o.label, value: String(o.value) }))}
                />
              </div>
            </div>
          </div>

          <div style={BUTTON_ROW}>
            <Button
              data-testid="txr-intake-study-continue"
              style={PRIMARY_BUTTON}
              onClick={continueFlow}
            >
              Continue to the files
            </Button>
            <Button
              data-testid="txr-intake-study-skip"
              style={OUTLINE_BUTTON}
              onClick={continueFlow}
            >
              Skip the questions
            </Button>
          </div>
        </section>

        <aside style={PANEL_COLUMN} data-testid="txr-intake-panel">
          <div>
            <div style={PANEL_COUNT} data-testid="txr-intake-panel-fit-count">
              {panel.fit !== null ? (
                <span style={{ fontWeight: 600 }}>{panel.fit.canRun}</span>
              ) : (
                <span style={{ fontWeight: 600, color: '#5e5e5e' }}>…</span>
              )}
              <span style={PANEL_SUFFIX}>
                {panel.fit !== null ? `of ${panel.fit.total} methods fit` : 'methods fit'}
              </span>
            </div>
            <p style={PANEL_SENTENCE} data-testid="txr-intake-panel-sentence">
              {descriptiveSentence(study)}
            </p>
          </div>

          {panel.fit !== null && panel.fit.some > 0 ? (
            <p style={PANEL_SOME_LINE} data-testid="txr-intake-panel-some">
              {someFitLine(panel.fit)}
            </p>
          ) : null}

          {panel.error !== null ? (
            <div role="alert" style={PANEL_ERROR}>
              {panel.error}
            </div>
          ) : null}

          <div style={UPLOAD_BOX}>
            <div style={UPLOAD_TITLE}>What you will upload</div>
            <ul style={UPLOAD_LIST}>
              <li>
                <b>Patients</b>: one row per patient, with the time and whether progression or
                death happened
              </li>
              <li>
                <b>Measurements</b>: one row per marker per blood draw (day, marker, value)
              </li>
            </ul>
            <Link style={LINK} to={mode === 'predict' ? PREDICT_FILES_ROUTE : FILES_ROUTE}>
              See example files
            </Link>
          </div>

          <div data-testid="txr-intake-panel-excluded">
            <div style={EXCLUDED_HEADING}>
              {panel.fit !== null ? leftOutHeading(panel.fit) : 'Methods are left out'}
            </div>
            {panel.fit !== null ? (
              shownExcluded.length > 0 ? (
                <ul style={EXCLUDED_LIST}>
                  {shownExcluded.map(method => (
                    <li key={method.id} style={EXCLUDED_LI}>
                      <span style={EXCLUDED_ID}>{method.id}</span>
                      <span style={EXCLUDED_REASON}>{method.reasonText}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div style={{ color: '#5e5e5e', fontSize: 13.5 }}>None</div>
              )
            ) : (
              <div style={{ color: '#5e5e5e', fontSize: 13.5 }}>…</div>
            )}
            {hasMoreExcluded ? (
              <Button
                data-testid="txr-intake-excluded-show-all"
                variant="link"
                style={LINK}
                onClick={() => setShowAllExcluded(show => !show)}
              >
                {showAllExcluded ? 'Show fewer' : `Show all ${excluded.length}`}
              </Button>
            ) : null}
          </div>
        </aside>
      </div>
    </div>
  )
}
