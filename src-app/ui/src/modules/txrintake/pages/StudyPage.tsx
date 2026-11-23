import { useCallback, useMemo } from 'react'
import type { CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from 'zustand'
import { Button, Checkbox, message, Select, Skeleton } from '@txresbench/kit'
import { useDocumentTitle } from '@/modules/txrshell/lib/document-title'
import { PageFrame } from '@/modules/txrshell/components/PageFrame'
import { ScrollRegion } from '@/modules/txrshell/components/ScrollRegion'
import { PageFooterBar } from '@/modules/txrshell/components/PageFooterBar'
import { useTxrIntakeStore } from '../stores/TxrIntake.store'
import { useMarkers } from '../data/useMarkers'
import { useFilterOptions } from '../data/useFilterOptions'
import { useStudyPreview } from '../data/useStudyPreview'
import {
  BEFORE_TREATMENT_OPTIONS,
  DRAWS_OPTIONS,
  EXCLUDED_LIST_LIMIT,
  FILTER_OPTIONS_UNAVAILABLE_LINE,
  OUTCOME_OPTIONS,
  leftOutHeading,
  someFitLine,
} from '../lib/format'
import { descriptiveSentence, hasStudyAnswers, PREVIEW_ANSWER_INVITE } from '../lib/preview'
import { formatNoEnvLine } from '@/modules/txrlist/lib/format'
import { TxrStepBack, TxrStepLine, useStepBack } from '../components/TxrStepBack'
import { TxrDayField } from '../components/TxrDayField'
import { TxrDiseasePicker } from '../components/TxrDiseasePicker'
import { TxrTreatmentTicks } from '../components/TxrTreatmentTicks'
import { TxrExcludedSections } from '../components/TxrExcludedSections'
import { useRecheck } from '../data/useRecheck'
import { drawCoverageLine, drawDayError, drawDayWarning, suggestDrawDays } from '../lib/dayChoices'
import { runAction } from '@/core/actions/defineAction'
import { FLOW_ROUTES, previousLearnRoute } from '@/modules/txrshell/lib/flowSteps'
import { isExampleStudy } from '../lib/example'
import { useAppMode } from '@/modules/demo'
import { DEMO_STUDY_NOTE } from '@/modules/demo/copy'
import type { OutcomeId } from '../types'

/**
 * Screen B — Your study (board Criteria.dc.html, ITEM-5): the six question
 * groups (disease, treatment, outcome, marker groups, before-treatment /
 * draws / last draw) and the live "N of M methods fit" panel with the
 * excluded list, rendered from the structured preview response
 * (CONS-UI-INTAKE-2) through the CONS-UI-INTAKE-9 reason formatters.
 *
 * The learn path's step 3: it comes after the files step, so "Last draw you
 * will use" offers the days the checked files suggest (`lib/dayChoices.ts`),
 * a number box for any other day and the day's coverage line. The day is the
 * engine's decision day too: the registered `flow.setLastDrawDay` stores both,
 * and the step checks the files again for the new day (`useRecheck`) before
 * Continue goes on to the methods.
 *
 * INV-1: every answer change re-runs the fit computation — the page writes
 * the disease, treatment and outcome answers through the registered
 * `intake.setStudyAnswers` action (the same validating path the AI drives,
 * brief 5b), the marker-group and schedule answers through the store, and
 * the panel hook keys its request on the answers' CONTENT with a 200 ms
 * debounce (a burst costs one eligibility call; the stale-response guard
 * keeps the panel honest).
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

/** The line under the last-draw field when no files are in memory (none added yet, or a reload). */
export const DAY_NO_FACTS_LINE = 'Add your files to see the days they suggest.'

/** The line beside Continue while the files are checked for a new day. */
export const RECHECK_LINE = 'Checking your files for the new day…'

/** The page's frame host (the shell's routed area). */
const PAGE_ROOT: CSSProperties = {
  height: '100%',
  minHeight: 0,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
}

/** The fixed top's content (the page's heading block). It starts where the
 *  body below starts: the body row is full width with the same 48 px side
 *  padding, so the heading is LEFT-aligned (the 1280 px cap only keeps the
 *  intro's lines readable). A centred heading (`margin: 0 auto`) drifted right
 *  of the body on any window wider than ~1280 px — the "Step 2 of 4" line
 *  moved and left a gap on its left. */
const PAGE_TOP: CSSProperties = {
  boxSizing: 'border-box',
  padding: '40px 48px 10px',
  maxWidth: 1280,
  margin: 0,
  width: '100%',
}

/** The two-region body row (the CSS `txr-shell-regions-row` byte: columns in
 *  shell mode ≥1024 px, stacked below and in flow mode). */
const BODY_ROW: CSSProperties = {
  flex: 1,
  minHeight: 0,
  minWidth: 0,
  boxSizing: 'border-box',
  display: 'flex',
  padding: '0 48px',
  gap: 28,
}

/** One region's content wrapper (the page chrome inside the scroll). */
const REGION_CONTENT: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  padding: '0 0 28px',
  minWidth: 0,
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

/** One question group block (the board's bordered sections). */
const QUESTION_GROUP: CSSProperties = {
  padding: '16px 0',
  borderBottom: '1px solid var(--txr-border-subtle)',
}

const QUESTION_LABEL: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--txr-muted)',
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
  border: '1px solid var(--txr-border)',
  background: 'var(--txr-surface)',
  color: 'var(--txr-text-2)',
}

const PILL_SELECTED: CSSProperties = {
  ...PILL,
  border: '1px solid var(--txr-brand)',
  background: 'var(--txr-accent-soft)',
  color: 'var(--txr-brand-ink)',
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

/** The panel's big count line (the board's big-number + suffix design). */
const PANEL_COUNT: CSSProperties = {
  fontFamily: "'Source Serif 4', Georgia, serif",
  fontSize: 40,
  fontWeight: 600,
  lineHeight: 1,
}

// qa-fixes ITEM-6 S1: the suffix begins with a SPACE — the number and "of"
// are separate spans and the report read "173of 359 methods fit".
const PANEL_SUFFIX: CSSProperties = {
  fontSize: 20,
  color: 'var(--txr-muted)',
  fontWeight: 400,
}

const PANEL_SENTENCE: CSSProperties = {
  margin: '4px 0 0',
  color: 'var(--txr-text-2)',
  fontSize: 14,
}

const PANEL_SOME_LINE: CSSProperties = {
  margin: 0,
  color: 'var(--txr-text-2)',
  fontSize: 13.5,
}

const PANEL_ERROR: CSSProperties = { margin: 0, color: 'var(--txr-danger)', fontSize: 13.5 }

/** The environment honesty line (CM-1's plain-voice rule, R2-1's separation). */
const PANEL_NO_ENV: CSSProperties = { margin: 0, fontSize: 12.5, color: 'var(--txr-warning)' }

/** The demo-study note (demo-mode ITEM-6: the answers left the example
 *  setup — the note names it, and the eligible set does not move). */
const DEMO_NOTE: CSSProperties = { margin: 0, fontSize: 13, color: 'var(--txr-muted)' }

/** The re-check note beside Continue. */
const RECHECK_NOTE: CSSProperties = { fontSize: 13, color: 'var(--txr-muted)' }

const EXCLUDED_HEADING: CSSProperties = { fontWeight: 700, marginBottom: 4 }

export function StudyPage() {
  const navigate = useNavigate()
  const study = useStore(useTxrIntakeStore, s => s.study)
  const intent = useStore(useTxrIntakeStore, s => s.intent)
  const mode = useStore(useTxrIntakeStore, s => s.mode)
  const patchStudy = useStore(useTxrIntakeStore, s => s.patchStudy)
  const dayFacts = useStore(useTxrIntakeStore, s => s.dayFacts)
  const validation = useStore(useTxrIntakeStore, s => s.validation)
  // The measurements of this path are in memory (gone after a reload: the
  // tables are never persisted, so there is nothing to suggest from).
  const measurementsInMemory = useStore(useTxrIntakeStore, s =>
    s.mode === 'predict' ? s.predictMeasurements !== null : s.measurements !== null,
  )
  const recheck = useRecheck()
  const { groups, loading: groupsLoading, error: groupsError } = useMarkers()
  const {
    categories,
    treatmentClasses,
    error: filterOptionsError,
  } = useFilterOptions()
  const panel = useStudyPreview(study, groups)
  const { isDemo } = useAppMode()
  // R2-G1: the tab/title byte is the page's own h1.
  useDocumentTitle('Tell us about your study')
  // The step's Back (the step trail): with no trail, the step before this one
  // (the files step of the learn path; the predict file step on the side trip).
  useStepBack({
    step: 'study',
    fallback: mode === 'predict' ? FLOW_ROUTES.predictFiles : previousLearnRoute('study'),
  })
  /** One checkbox toggle: the answer map grows/shrinks explicitly (DEC-5). */
  const setGroup = useCallback(
    (groupId: string, checked: boolean) => {
      patchStudy({ markerGroups: { ...(study.markerGroups ?? {}), [groupId]: checked } })
    },
    [patchStudy, study.markerGroups],
  )

  /**
   * The registered study-answers action (step2-filters): the disease,
   * treatment and outcome answers are the method filters, so the SAME
   * validates-the-vocabulary path the AI drives is the human controls' path —
   * never a parallel store write. A refusal is shown, never silent.
   */
  const applyAnswer = useCallback(
    async (patch: {
      disease_group?: string | null
      treatment_classes?: string[]
      outcome?: OutcomeId | null
    }) => {
      try {
        await runAction('intake.setStudyAnswers', patch)
      } catch (error) {
        message.error(error instanceof Error ? error.message : 'Could not set the answer.')
      }
    },
    [],
  )

  /** The last-draw answer is the engine's decision day (one value): the
   *  registered action stores both, and the files are checked again. A
   *  refusal (an action that does not take the day) is shown, never silent. */
  const setLastDrawDay = useCallback((day: number) => {
    void runAction('flow.setLastDrawDay', { day }).catch((error: unknown) => {
      message.error(error instanceof Error ? error.message : 'Could not set the day.')
    })
  }, [])
  const drawDays = useMemo(() => (dayFacts === null ? [] : suggestDrawDays(dayFacts)), [dayFacts])
  const lastDrawDay = study.lastDrawDay
  const lookAheadMax = dayFacts?.limits.look_ahead_day_max ?? null
  const checkDrawDay = useCallback(
    (day: number): string | null =>
      lookAheadMax === null
        ? Number.isInteger(day) && day >= 1
          ? null
          : 'Choose a whole day from 1.'
        : drawDayError(day, lookAheadMax),
    [lookAheadMax],
  )

  /**
   * Continue / Skip: the next step of THIS path. The learn path goes on to the
   * methods once its files are checked, and to the files step when they are
   * not in yet (the Start "Not sure which fits?" link, or a reload); the
   * predict side trip goes back to its file step.
   */
  const learnFilesIn = mode === 'study' && validation !== null
  const continueFlow = useCallback(() => {
    if (intent !== 'train' || mode === 'predict') {
      navigate(FLOW_ROUTES.predictFiles)
      return
    }
    // The check is the gate: read the CURRENT validation at click time (the
    // render-computed `learnFilesIn` can race a re-check that just started),
    // and while a re-check is owed stay put — Continue keeps its loading look
    // until it settles.
    const current = useTxrIntakeStore.getState().validation
    if (current !== null) {
      navigate(FLOW_ROUTES.methods)
      return
    }
    if (recheck.pending()) return
    navigate(FLOW_ROUTES.files)
  }, [navigate, intent, mode, recheck.pending])
  const continueLabel =
    intent !== 'train' || mode === 'predict'
      ? 'Continue to the patients to predict'
      : learnFilesIn || recheck.checking
        ? 'Continue to the methods'
        : 'Continue to the files'

  const excluded = panel.excluded
  // R2-1: with NOTHING answered the panel says what to do, not a count — the
  // old page reported "N of M methods fit" from a request the user never
  // composed (all groups false + the default schedule); the count answers
  // only after the first answer exists.
  const answered = hasStudyAnswers(study)

  return (
    <div
      role="main"
      style={PAGE_ROOT}
      className="txr-intake-page txr-intake-study-page"
      data-testid="txr-intake-study"
    >
      <PageFrame
        top={
          <div className="txr-intake-top txr-intake-page-top" style={PAGE_TOP}>
            <TxrStepLine step="study" />
            <h1 style={TITLE}>Tell us about your study</h1>
            <p style={INTRO}>
              So you see which methods can run on your study. All optional: skip any question and
              we go by your files instead.
            </p>
          </div>
        }
        body={
          <div className="txr-shell-regions-row" style={BODY_ROW}>
            <ScrollRegion label="Study questions" className="txr-study-questions-region">
              <div className="txr-intake-page-body" style={REGION_CONTENT}>
                <div style={QUESTION_GROUP}>
                  <div style={QUESTION_LABEL}>Patients</div>
                  <div style={FIELD_ROW}>
                    {/* study-step-ui-tweaks: the disease box takes the full
                        width of the filters column (the picker's trigger is
                        `w-full` of this field; the wrapper carries
                        `minWidth: 0`), so the treatment ticks wrap to their
                        own row beneath it. */}
                    <div style={{ ...FIELD, flex: '1 1 100%', minWidth: 0 }}>
                      <span style={FIELD_LABEL}>Disease</span>
                      <TxrDiseasePicker
                        value={study.disease}
                        categories={categories}
                        onChange={disease => applyAnswer({ disease_group: disease })}
                      />
                    </div>
                    <div style={FIELD}>
                      <span style={FIELD_LABEL}>Treatment</span>
                      <TxrTreatmentTicks
                        value={study.treatments}
                        treatments={treatmentClasses}
                        onChange={treatments => applyAnswer({ treatment_classes: treatments })}
                      />
                    </div>
                  </div>
                  {/* 5a3: ONE line, plain words, no raw fetch error — the
                      old page repeated the raw message under both the
                      Disease and the Treatment control. */}
                  {filterOptionsError !== null ? (
                    <div role="alert" data-testid="txr-intake-filter-options-error" style={PANEL_ERROR}>
                      {FILTER_OPTIONS_UNAVAILABLE_LINE}
                    </div>
                  ) : null}
                </div>

                <div style={QUESTION_GROUP}>
                  <div style={QUESTION_LABEL}>What you want to predict</div>
                  <div style={PILLS} className="txr-intake-pills" role="group" aria-label="What you want to predict">
                    {OUTCOME_OPTIONS.map(option => {
                      const selected = study.outcome === option.value
                      return (
                        <Button
                          key={option.value}
                          data-testid={`txr-intake-study-outcome-${option.value}`}
                          variant="outline"
                          aria-pressed={selected}
                          style={selected ? PILL_SELECTED : PILL}
                          onClick={() => applyAnswer({ outcome: selected ? null : option.value })}
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
                      <TxrDayField
                        testId="txr-intake-study-last-draw"
                        label="Last draw you will use"
                        value={lastDrawDay}
                        suggestions={drawDays}
                        onChoose={setLastDrawDay}
                        check={checkDrawDay}
                        coverage={
                          dayFacts !== null && lastDrawDay !== null
                            ? drawCoverageLine(dayFacts, lastDrawDay)
                            : null
                        }
                        warning={
                          dayFacts !== null && lastDrawDay !== null
                            ? drawDayWarning(dayFacts, lastDrawDay)
                            : null
                        }
                        noFacts={dayFacts === null && !measurementsInMemory ? DAY_NO_FACTS_LINE : null}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </ScrollRegion>

            <ScrollRegion label="Methods that fit your answers" className="txr-study-panel-region">
              <div className="txr-intake-page-body" style={REGION_CONTENT} data-testid="txr-intake-panel">
                <div>
                  {answered ? (
                    <>
                      <div style={PANEL_COUNT} data-testid="txr-intake-panel-fit-count">
                        {panel.fit !== null ? (
                          <span style={{ fontWeight: 600 }}>{panel.fit.fit}</span>
                        ) : (
                          <span style={{ fontWeight: 600, color: 'var(--txr-muted)' }}>…</span>
                        )}
                        <span style={PANEL_SUFFIX}>
                          {panel.fit !== null
                            ? ` of ${panel.fit.total} methods fit your study`
                            : ' methods fit your study'}
                        </span>
                      </div>
                      <p style={PANEL_SENTENCE} data-testid="txr-intake-panel-sentence">
                        {descriptiveSentence(study)}
                      </p>
                    </>
                  ) : (
                    <p style={PANEL_SENTENCE} data-testid="txr-intake-panel-sentence">
                      {PREVIEW_ANSWER_INVITE}
                    </p>
                  )}
                </div>

                {answered && panel.fit !== null && panel.fit.noEnvFit > 0 ? (
                  <p data-testid="txr-intake-panel-no-env" style={PANEL_NO_ENV}>
                    {formatNoEnvLine(panel.fit.noEnvFit)}
                  </p>
                ) : null}

                {answered && panel.fit !== null && panel.fit.some > 0 ? (
                  <p style={PANEL_SOME_LINE} data-testid="txr-intake-panel-some">
                    {someFitLine(panel.fit)}
                  </p>
                ) : null}

                {/* demo-mode ITEM-6: the demo's verdicts answer from the
                    bundle — the count and the methods are the recorded ones,
                    and answers outside the example setup say so. */}
                {isDemo && answered && !isExampleStudy(study) ? (
                  <p data-testid="txr-intake-panel-demo-note" style={DEMO_NOTE}>
                    {DEMO_STUDY_NOTE}
                  </p>
                ) : null}

                {panel.error !== null ? (
                  <div role="alert" style={PANEL_ERROR}>
                    {panel.error}
                  </div>
                ) : null}

                <div data-testid="txr-intake-panel-excluded">
                  <div style={EXCLUDED_HEADING}>
                    {panel.fit !== null ? leftOutHeading(panel.fit) : 'Methods are left out'}
                  </div>
                  {!answered ? (
                    <div style={{ color: 'var(--txr-muted)', fontSize: 13.5 }}>…</div>
                  ) : panel.fit !== null ? (
                    excluded.length > 0 ? (
                      <TxrExcludedSections excluded={excluded} limit={EXCLUDED_LIST_LIMIT} />
                    ) : (
                      <div style={{ color: 'var(--txr-muted)', fontSize: 13.5 }}>None</div>
                    )
                  ) : (
                    <div style={{ color: 'var(--txr-muted)', fontSize: 13.5 }}>…</div>
                  )}
                </div>
              </div>
            </ScrollRegion>
          </div>
        }
        bottom={
          <PageFooterBar className="txr-study-footer">
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14 }}>
              <TxrStepBack />
              <Button
                data-testid="txr-intake-study-continue"
                style={PRIMARY_BUTTON}
                disabled={recheck.checking}
                onClick={continueFlow}
              >
                {continueLabel}
              </Button>
              <Button
                data-testid="txr-intake-study-skip"
                style={OUTLINE_BUTTON}
                disabled={recheck.checking}
                onClick={continueFlow}
              >
                Skip the questions
              </Button>
              {recheck.checking ? (
                <span data-testid="txr-intake-study-recheck" style={RECHECK_NOTE}>
                  {RECHECK_LINE}
                </span>
              ) : recheck.error !== null ? (
                <span role="alert" data-testid="txr-intake-study-recheck-error" style={PANEL_ERROR}>
                  {recheck.error}
                </span>
              ) : null}
            </div>
          </PageFooterBar>
        }
      />
    </div>
  )
}
