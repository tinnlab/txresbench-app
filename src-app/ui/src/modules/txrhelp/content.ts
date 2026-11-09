/**
 * txrhelp content — the Help page's text as DATA (qa-fixes2 ITEM-3 redesign).
 *
 * The content is typed (HelpSection / HelpBlock / HelpProblemEntry in
 * `types.ts`) and contains no logic: the renderer (`pages/HelpPage.tsx` and
 * its block components) and the tests are the only consumers, so a wording
 * change is a data change with no code churn. Everything here is plain,
 * accurate to the shipped behaviour (DEC-5): it describes what the app DOES,
 * not what a future version may do; it carries no status, no progress wording
 * and no unfinished-work markers; every term is spelled the way the screens
 * spell it. The location-neutral copy rules of ITEM-2 apply throughout.
 *
 * The problem-code entries are the authored prose of the closed vocabulary of
 * the server's file validator (`ProblemCode::ALL` — 28 codes). The machine
 * facts — the severity group and whether the app reports a code at all — come
 * from `validator-catalog.json`, the committed catalogue the server generates
 * from its own declaration tables (`RULES` + `APP_RULES`, rendered by
 * `file_validator::catalog`), so a code/severity/application change cannot
 * drift away from the Help page (the two-sided drift test is the server's
 * `catalog_roundtrip_and_committed_copy` + this module's own pins).
 */

import type {
  HelpProblemEntry,
  HelpSection,
  ProblemGroup,
  QuickStartCard,
  ValidatorCatalogEntry,
} from './types'
import validatorCatalogJson from './validator-catalog.json'

/**
 * The committed validator catalogue (the server's declaration tables). The
 * JSON module resolves widest literals to `string`, so the shape is cast at
 * this one seam; the byte structure is pinned by the server's drift test
 * (`file_validator::catalog::catalog_roundtrip_and_committed_copy`) and by
 * the unit pins below.
 */
export const VALIDATOR_CATALOG: readonly ValidatorCatalogEntry[] =
  validatorCatalogJson as unknown as readonly ValidatorCatalogEntry[]

// ─────────────────────────────────────────────────────────────────────────────
// Quick start (the top-of-page row mirroring the Start screen's three ways)
// ─────────────────────────────────────────────────────────────────────────────

export const QUICK_START: readonly QuickStartCard[] = [
  {
    id: 'pretrained',
    eyebrow: 'Quickest',
    title: 'Predict with a pretrained model',
    text: 'Add the blood measurements of the patients you want predictions for. The app shows which pretrained models can run on them.',
    screen: 'Screen N — Predict files',
    route: '/predict-files',
    cta: 'Add the patients to predict',
  },
  {
    id: 'learn',
    eyebrow: 'Most flexible',
    title: 'Learn from my data',
    text: 'Train the methods on your own patients with known outcomes, then predict new patients. Select as many methods as you like.',
    screen: 'Screen B — Your study',
    route: '/study',
    cta: 'Add my data',
  },
  {
    id: 'saved',
    eyebrow: 'Repeat a past analysis',
    title: 'Use a model I saved',
    text: 'Add the patients to predict, then pick any of the models you trained before. No need to upload the training data again.',
    screen: 'Screen N — Predict files',
    route: '/predict-files',
    cta: 'Predict with a model I saved',
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// The sections, in page order (the TOC renders this order)
// ─────────────────────────────────────────────────────────────────────────────

export const HELP_SECTIONS: readonly HelpSection[] = [
  {
    id: 'overview',
    title: 'What TxResBench does',
    blocks: [
      {
        kind: 'paragraph',
        text: 'TxResBench predicts treatment response from repeated blood biomarker measurements. You bring two tables — one row per patient with their outcome, one row per blood draw and marker — and you see per-patient predictions for every method you ran.',
      },
      {
        kind: 'bullets',
        items: [
          'Every method runs in its own isolated environment.',
          'You can train many methods at once and compare their per-patient predictions.',
          'You can save the trained models, reuse them on new patients, and return to any past run from the history.',
        ],
      },
    ],
  },
  {
    id: 'steps',
    title: 'The four steps',
    blocks: [
      {
        kind: 'stepper',
        steps: [
          {
            number: 1,
            name: 'Start',
            lines: [
              'Pick the way in: a pretrained model, learn from my data, or a model I saved.',
              'The three cards name what each way needs.',
            ],
            screen: 'Screen A — Start',
            details: [
              {
                kind: 'bullets',
                items: [
                  '"Predict with a pretrained model" — button "Add the patients to predict".',
                  '"Learn from my data" — button "Add my data".',
                  '"Use a model I saved" — button "Predict with a model I saved".',
                  'Not sure? "Answer a few questions about your study on the next screen", or load "Try the example data" to explore with the project\'s own sample files.',
                ],
              },
            ],
          },
          {
            number: 2,
            name: 'Your study',
            lines: [
              'Answer the seven question groups: disease, treatment, what to predict, markers, and the three draw questions.',
              'The "N of M methods fit" panel updates as you answer.',
            ],
            screen: 'Screen B — Your study',
            details: [
              {
                kind: 'bullets',
                items: [
                  'The groups are Disease; Treatment; What you want to predict; Blood markers you measured; Before treatment; Draws during treatment; Last draw you will use.',
                  '"Continue to the files" moves on; "Skip the questions" uses the defaults. Any of the three ways in can answer these questions.',
                ],
              },
            ],
          },
          {
            number: 3,
            name: 'Your files',
            lines: [
              'Add a patients table and a measurements table; with a model, only the measurements of the patients to predict.',
              'Each file is checked the moment you choose it. Problems are listed under the card.',
            ],
            screen: 'Screen C — Your files',
            details: [
              {
                kind: 'bullets',
                items: [
                  'CSV or Excel. The columns can be in any order — the app finds the names, by name or by common spellings.',
                  'A problem line shows the row number and its code; the code links to its entry here.',
                ],
              },
            ],
          },
          {
            number: 4,
            name: 'Methods and run',
            lines: [
              'Pick the methods, set the run settings, and click "Run N methods". The running screen shows each method\'s state live.',
              'You can leave. The run continues and stays in History.',
            ],
            screen: 'Screen D/E — Methods and running',
            details: [
              {
                kind: 'bullets',
                items: [
                  '"Run at a time" sets how many methods run side by side; a lower number uses less memory and CPU.',
                  '"Save the trained models" keeps each trained method for later runs.',
                  'When a method finishes, its predictions appear: "See the results".',
                ],
              },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'files',
    title: 'Preparing your files',
    blocks: [
      {
        kind: 'paragraph',
        text: 'Plain CSV or Excel. The first row is the header. Templates and full examples are available under each file card on the Files screen.',
      },
      {
        kind: 'fileCard',
        card: {
          file: 'patients',
          title: 'Patients table — one row per patient',
          summary: 'One row per patient: the ids, the outcome times and events, and any covariate columns you measured.',
          columns: [
            {
              name: 'patient_id',
              required: true,
              meaning: 'your own patient code — the same code in both files',
              example: 'P0001',
            },
            {
              name: 'pfs_days',
              required: true,
              meaning: 'days until progression or death, or until the last follow-up',
              example: '214',
            },
            {
              name: 'pfs_event',
              required: true,
              meaning: '1 = progressed or died, 0 = still well at last follow-up',
              example: '1',
            },
            {
              name: 'os_days',
              required: true,
              meaning: 'days until death, or until the last follow-up',
              example: '214',
            },
            {
              name: 'os_event',
              required: true,
              meaning: '1 = died, 0 = alive at last follow-up',
              example: '0',
            },
            {
              name: 'responder',
              required: false,
              meaning: 'the response outcome: 1/0, paired with response_day',
              example: '1',
            },
            {
              name: 'response_day',
              required: false,
              meaning: 'the day the response was assessed',
              example: '56',
            },
            {
              name: 'age · sex · stage or cov_<name>',
              required: false,
              meaning: 'extra inputs some methods use; any other column is left out of the analysis',
              example: '58',
            },
          ],
          exampleRows:
            'patient_id,pfs_days,pfs_event,os_days,os_event,age,sex,stage\nJ0000,203,1,203,1,47,F,III\nJ0001,358,0,358,0,30,F,III\nJ0002,406,1,406,1,72,F,III',
        },
      },
      {
        kind: 'fileCard',
        card: {
          file: 'measurements',
          title: 'Measurements table — one row per marker per blood draw',
          summary: 'One row per marker value at one draw: who, which day, which marker, the value and its unit.',
          columns: [
            {
              name: 'patient_id',
              required: true,
              meaning: 'the patient code from the patients table',
              example: 'P0001',
            },
            {
              name: 'day',
              required: true,
              meaning: 'days from the start of treatment — day 0 is the first treatment day, draws before it are negative',
              example: '0',
            },
            {
              name: 'marker',
              required: true,
              meaning: 'the marker\'s name as you write it, for example LDH or ctDNA',
              example: 'LDH',
            },
            {
              name: 'value',
              required: true,
              meaning: 'a number; a blank entry means no measurement at that draw — a blank is not a zero',
              example: '310',
            },
            {
              name: 'unit',
              required: false,
              meaning: 'for example U/L — lets the app check the scale against the method\'s expectation',
              example: 'U/L',
            },
          ],
          exampleRows:
            'patient_id,day,marker,value,unit\nJ0000,0,M1,12.4,a.u.\nJ0000,0,M2,4.6,a.u.\nJ0000,21,M1,16.2,a.u.',
        },
      },
      {
        kind: 'bullets',
        items: [
          'One row per draw per marker. The pair patient + day + marker must be unique; the same marker twice in one draw is a duplicate the app reports (R07 lists every row).',
          'Measurement days outside −180 to 3650 raise a warning (R20). Months are not days.',
          'Outcomes pair a time column with a 0/1 event column — pfs, os and responder each both-or-neither (R18).',
          'Spelling variants of one marker (ldh / LDH) are offered as joins — suggestions only, never applied on their own (A03).',
        ],
      },
      {
        kind: 'callout',
        tone: 'tip',
        text: 'Start from the template if your file is a blank sheet: under each file card, "Download the template (CSV)" gives the header row; "Download the full example" gives a complete readable table.',
      },
      {
        kind: 'callout',
        tone: 'watch',
        text: 'A blank value cell means "no measurement at that draw". It is not a zero, and it does not block the analysis.',
      },
    ],
  },
  {
    id: 'choosing-methods',
    title: 'Choosing methods',
    blocks: [
      {
        kind: 'paragraph',
        text: 'On step 4 you pick the published methods to run. Each row shows the method\'s name and publication, its group, an estimated time, and whether it can run on your file. The methods are grouped into four families: response call, response probability, static risk and dynamic risk.',
      },
      {
        kind: 'bullets',
        items: [
          'The estimate is the benchmark\'s measured runtime scaled to your file — about 150 patients and 4 CPUs are the reference, so more patients or fewer CPUs lengthen the estimate. The bottom bar sums your selection; the estimate lines say they are estimates.',
          'With "Run at a time" you choose how many methods run side by side; a lower number uses less memory and CPU. "Save the trained models" keeps each trained method so you can reuse it without re-training.',
          'A method that cannot run is never silent: its row is greyed out with the reason — a marker missing from your file, not enough draws, extra inputs your file lacks, an outcome column your file lacks, or units that do not match.',
        ],
      },
      {
        kind: 'callout',
        tone: 'tip',
        text: 'The notice under the list is part of the app: predictions are for research, not for deciding a patient\'s treatment.',
      },
    ],
  },
  {
    id: 'statuses',
    title: 'Status words on the screens',
    blocks: [
      {
        kind: 'paragraph',
        text: 'The same chips appear on the method list, the models screens and the running screen, always with these meanings.',
      },
      {
        kind: 'statuses',
      },
    ],
  },
  {
    id: 'results',
    title: 'Reading results',
    blocks: [
      {
        kind: 'paragraph',
        text: 'The results page is a patient × method heatmap: one column per finished method, one row per patient, each value that method\'s chance for that patient — 0 to 100 %. Columns appear as methods finish, so a run that is still going grows the table live.',
      },
      {
        kind: 'bullets',
        items: [
          'The outcome tabs say what the chance is of; N is the run\'s horizon or response day.',
          'What a method predicts natively differs — a call, a probability or a risk score. The app turns each into the same chance column; when the run has data to calibrate on, the risk is recalibrated on your patients. The provenance is shown per column ("How the chance is calculated"). A method that cannot be converted says so instead of inventing a number.',
          'The Average column is the mean of the row\'s chances; Sort orders by it. The "Methods" dropdown narrows the columns.',
          'The actions are "Download all predictions (CSV)", "Save the models (N)" for a finished run, and "New analysis".',
          'You can leave while the run continues; every finished method is already in the table, and History keeps the run.',
        ],
      },
    ],
  },
  {
    id: 'models',
    title: 'Saved models and pretrained models',
    blocks: [
      {
        kind: 'paragraph',
        text: 'There are two ways to predict without training on your own data, and one place that keeps everything you trained.',
      },
      {
        kind: 'bullets',
        items: [
          'Pretrained models — the project\'s published models, checked against your measurements file on the models screen: which ones can run, what they were learned on, how they performed on other cohorts, and their time.',
          'Saved models — the models you trained, grouped by training run. Add the patients to predict and pick from them; the training data never has to be re-uploaded, and the app checks the new patients have the markers each model needs.',
          'Your models — the inventory of everything you saved: model, method, what it predicts, decision day, what it was trained on and when it was made. Rename, or delete a set to remove its files. "Open a model file" reads one you saved as a file.',
        ],
      },
      {
        kind: 'callout',
        tone: 'note',
        text: 'Use the same measurement columns and unit scale as the training run whenever you can. The app warns when a scale does not match.',
      },
    ],
  },
  {
    id: 'history',
    title: 'Run history',
    blocks: [
      {
        kind: 'paragraph',
        text: 'History lists everything you ran, newest first. Each card shows the title, the methods, the status and the date; "Show details" opens the run\'s files, settings, per-method versions and actions.',
      },
      {
        kind: 'bullets',
        items: [
          'The actions on a run: open the results, run again with the same settings, download the predictions, show the run log, delete the run.',
          'The footer counts the runs and the space they use, and holds the two retention controls: stop keeping file copies, and clear all runs (each with a confirmation).',
          'Deleting a run keeps the saved models, unless you remove them too.',
        ],
      },
    ],
  },
  {
    id: 'privacy',
    title: 'Privacy',
    blocks: [
      {
        kind: 'paragraph',
        text: 'The app does not track you and uses no analytics. Your files are used only to run the analyses you start. You can delete runs, models and history yourself.',
      },
      {
        kind: 'bullets',
        items: [
          'A method\'s analysis environment is downloaded once and reused by later runs.',
          'While a method runs, its sandbox has no network access at all.',
        ],
      },
    ],
  },
  {
    id: 'data-location',
    title: 'What the app keeps',
    blocks: [
      {
        kind: 'paragraph',
        text: 'The app keeps the run database, the per-run folders (your files, the trained models and the predictions), the saved models, the downloaded analysis environments and its cache.',
      },
      {
        kind: 'callout',
        tone: 'note',
        text: 'Remove runs from History — with their file copies — and delete the models you no longer need to reclaim space.',
      },
    ],
  },
  {
    id: 'troubleshooting',
    title: 'Troubleshooting',
    blocks: [
      {
        kind: 'paragraph',
        text: 'When a file has problems, the card under it lists one line per problem with the row number. Every line carries its code; the code links to the entry here. Errors block the analysis. Warnings are reported and do not stop you.',
      },
      {
        kind: 'paragraph',
        text: 'A few codes need context: R08 and R15 report the same mistake twice — one for the measurement row, one for the draw — fix the spelling once and both clear. R12 reads the patients table. A non-numeric day is reported as R03, not as a missing draw.',
      },
    ],
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// The status vocabulary (the meanings; the labels/tones are the sibling
// modules' own constants — txrlist's three verdicts, txrrun's eight states).
// ─────────────────────────────────────────────────────────────────────────────

/** The eligibility verdict keys, in the order the method list shows them. */
export const ELIGIBILITY_STATUSES: readonly {
  status: 'can' | 'some' | 'cannot'
  meaning: string
}[] = [
  {
    status: 'can',
    meaning: 'The method has everything it needs on every patient.',
  },
  {
    status: 'some',
    meaning: 'It runs where the requirements are met — the row says who, for example "needs 3 or more draws".',
  },
  {
    status: 'cannot',
    meaning: 'The row is greyed out with the reason: a marker missing from the file, too few draws, an extra input, an outcome column, or units that do not match.',
  },
]

/** The run states' meanings, in the order the running screen lists them. */
export const RUN_STATE_MEANINGS: readonly { state: string; meaning: string }[] = [
  { state: 'waiting', meaning: 'Queued. It starts when a lane frees up.' },
  { state: 'downloading', meaning: 'Getting its environment — once, then reused.' },
  { state: 'running', meaning: 'Fitting the model or predicting now. The row shows its latest message.' },
  { state: 'finished', meaning: 'Done. Its predictions are in the results table.' },
  { state: 'failed', meaning: 'Ended with an error. The row keeps the reason.' },
  { state: 'stopped', meaning: 'You stopped it before it finished.' },
  { state: 'skipped', meaning: 'Never started — it was still waiting when the run was stopped or you skipped it.' },
  { state: 'cannot_run', meaning: 'Not started. The row says what the file lacks.' },
]

// ─────────────────────────────────────────────────────────────────────────────
// The problem-code entries (prose) + the catalogue-driven severity group
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The problem-code entries — the validator's CLOSED 28-code vocabulary
 * (R01–R21 + A01–A07), one entry per code. The severity group each entry
 * renders under comes from the catalogue (see [problemGroupOf]); the prose
 * here is the authored meaning and action, checked against the validator's
 * real messages (R2-H8: A04 reports BOTH severities, R10 never fires, A07
 * only after a confirmed marker mapping, R12 reads the patients table).
 */
export const PROBLEM_HELP: readonly HelpProblemEntry[] = [
  {
    code: 'R01',
    anchor: 'problem-r01',
    title: 'tables present',
    meaning: 'The tidy benchmark rule "both tables are present". The app\'s request contract always carries the two files, so this code is never reported.',
    action: 'Nothing to do — the app never issues this one.',
  },
  {
    code: 'R02',
    anchor: 'problem-r02',
    title: 'a required column is missing',
    meaning: 'One of the required columns is missing: the patients table needs patient_id, pfs_days, pfs_event, os_days and os_event (responder and response_day are extra); the measurements table needs patient_id, day, marker and value.',
    action: 'Add the missing column and choose the file again. The message names the column and the table.',
  },
  {
    code: 'R03',
    anchor: 'problem-r03',
    title: 'a value has the wrong type',
    meaning: 'A value is not the type its column needs: day, value and the outcome times must be numbers; event and responder columns 0/1 integers; ids, marker names and units are text even when they look like numbers. A day written as "week 4" is this code.',
    action: 'Fix the named entry — the message repeats the offending value — then choose the file again.',
  },
  {
    code: 'R04',
    anchor: 'problem-r04',
    title: 'a required cell is empty',
    meaning: 'A cell that must not be empty is empty: patient_id, day and marker in the measurements table; patient_id in the patients table; a present time_unit value.',
    action: 'Fill the entry or remove the row. A blank in the value column is the one blank that is allowed — it means "no measurement".',
  },
  {
    code: 'R05',
    anchor: 'problem-r05',
    title: 'a value other than 0 or 1',
    meaning: 'An event or response column (pfs_event, os_event, responder) holds a value other than 0 or 1. The value must be the integer 0 or 1.',
    action: 'Code the column as 0/1. A non-number such as "yes" is reported first as R03, not as this code.',
  },
  {
    code: 'R06',
    anchor: 'problem-r06',
    title: 'an outcome day below zero',
    meaning: 'An outcome time (pfs_days, os_days, response_day) is negative. Outcome times count from the start of treatment and cannot be negative.',
    action: 'Correct the day, or leave the entry empty when the outcome never occurred (the event column must be empty too — R18).',
  },
  {
    code: 'R07',
    anchor: 'problem-r07',
    title: 'duplicate rows',
    meaning: 'patient_id repeats in the patients table, or the same patient + day + marker repeats in the measurements table — one row per patient, one row per draw per marker. The message lists every row of each group.',
    action: 'Remove the duplicate rows. Two draws on the same day are two rows: keep them distinct or merge them yourself.',
  },
  {
    code: 'R08',
    anchor: 'problem-r08',
    title: 'a measurement row names a patient the patients table does not have',
    meaning: 'Files mode only — the predict-only mode has no patients side, so this code does not apply there.',
    action: 'Check the spelling — one stray space or an extra digit is enough — or add the patient row. The same mistake is reported again as R15 on the derived draw; fix it once and both clear.',
  },
  {
    code: 'R09',
    anchor: 'problem-r09',
    title: 'a value row\'s draw',
    meaning: 'The tidy rule "every value row\'s draw exists". The app derives a draw from the value rows themselves (the patient + day key), so the rule holds by construction.',
    action: 'Nothing to do — this code cannot appear; a day that is not a number is reported as R03 instead.',
  },
  {
    code: 'R10',
    anchor: 'problem-r10',
    title: 'a marker the feature list does not mention',
    meaning: 'The tidy rule "every measurement marker is described". The app folds the feature list from the measurement rows themselves, so every marker a row names is described by construction.',
    action: 'Nothing to do — this code cannot appear. Spelling variants (ldh / LDH) are reported under A03 as a join offer.',
  },
  {
    code: 'R11',
    anchor: 'problem-r11',
    title: 'a value row\'s day',
    meaning: 'The tidy rule "a value row\'s day agrees with its draw\'s day". The draw\'s day IS the value row\'s day (the same key), so the rule holds by construction.',
    action: 'Nothing to do — this code cannot appear.',
  },
  {
    code: 'R12',
    anchor: 'problem-r12',
    title: 'a time_unit other than days',
    meaning: 'In the PATIENTS table, a time_unit column is present and says something other than "days". The app\'s day columns are always days; any other unit cannot be interpreted. A time_unit column in the measurements table is simply not recognised.',
    action: 'Change the value in the patients table to "days" in every row, or remove the column.',
  },
  {
    code: 'R13',
    anchor: 'problem-r13',
    title: 'a companion column is wrong',
    meaning: 'A marker\'s companion columns are wrong: "<marker>__detected" must be 0/1, "<marker>__lod" must be 0 or more, and the companion needs its base marker described in the file.',
    action: 'Fix the companion the message names, or remove the column if your file does not use detection calls.',
  },
  {
    code: 'R14',
    anchor: 'problem-r14',
    title: 'few patients with an outcome',
    meaning: 'Fewer than 10 patients carry a primary outcome, so a trained method has very little to learn from. The file is usable; the warning says which outcome is best covered.',
    action: 'Add more patients with outcomes, or keep the file and expect wide uncertainties. It is a note, not a block.',
  },
  {
    code: 'R15',
    anchor: 'problem-r15',
    title: 'a derived draw without a patient',
    meaning: 'Files mode: a drawn (patient, day) pair is not in the patients table. It is the same mistake as R08, reported on the derived draw side — the row\'s patient is missing too.',
    action: 'Check the patient_id spelling against the patients table, or add the missing patient row. Fix the spelling once and R08 and R15 both clear.',
  },
  {
    code: 'R16',
    anchor: 'problem-r16',
    title: 'a value row naming a different patient',
    meaning: 'The tidy rule "a value row names the same patient as its draw". The draw\'s patient IS the value row\'s patient (the same key), so the rule holds by construction.',
    action: 'Nothing to do — this code cannot appear.',
  },
  {
    code: 'R17',
    anchor: 'problem-r17',
    title: 'an unknown draw day',
    meaning: 'The tidy rule "a draw\'s day is null exactly when the day source is unknown". The app\'s days always come from the file — never "unknown" — so the rule holds by construction.',
    action: 'Nothing to do — this code cannot appear. A non-numeric day is reported as R03.',
  },
  {
    code: 'R18',
    anchor: 'problem-r18',
    title: 'an unpaired time and event',
    meaning: 'An outcome column is only half-filled: pfs_days with pfs_event, os_days with os_event, and responder with response_day must each be both or neither.',
    action: 'Pair the columns: empty time with empty event (the outcome never happened), or a day with its 0/1 event.',
  },
  {
    code: 'R19',
    anchor: 'problem-r19',
    title: 'an outcome at day 0',
    meaning: 'A pfs_days or os_days value is exactly 0 — a day-0 event is unusual, not impossible (an immediate progression). The response assessment day is not checked by this rule.',
    action: 'Confirm the day. If the event happened before treatment started, the row is probably wrong.',
  },
  {
    code: 'R20',
    anchor: 'problem-r20',
    title: 'a measurement day outside the range',
    meaning: 'A measurement day is outside −180 to 3650 days from the start of treatment. The row is kept; the app warns because such a draw is unusual.',
    action: 'Check the day\'s sign and scale — months are not days. The message names the row so you can decide.',
  },
  {
    code: 'R21',
    anchor: 'problem-r21',
    title: 'preview files agree',
    meaning: 'The tidy rule "the preview files agree with the data". The app has no preview files — any preview is generated from your rows by the run — so the rule is declared not applicable.',
    action: 'Nothing to do — the app never issues this one.',
  },
  {
    code: 'A01',
    anchor: 'problem-a01',
    title: 'no recognizable header',
    meaning: 'None of the file\'s columns matches a known name, so the app cannot tell the header row from the data — usually a title row above the header, or a sheet with the table further down.',
    action: 'Make row 1 the header with the column names — see "Preparing your files" — or pick the sheet that starts at the header.',
  },
  {
    code: 'A02',
    anchor: 'problem-a02',
    title: 'no outcome column',
    meaning: 'The patients table carries none of the outcome column sets — no pfs, no os, no responder / response_day — so no analysis can be built on it.',
    action: 'Add at least one outcome set: pfs_days + pfs_event, os_days + os_event, or responder + response_day.',
  },
  {
    code: 'A03',
    anchor: 'problem-a03',
    title: 'marker spellings that look the same',
    meaning: 'Two or more spellings of one marker appear in the measurements file — ldh and LDH, ctDNA and ct-DNA. Until you decide, they are treated as separate columns.',
    action: 'Accept the join offer under the card ("join them?") to merge the spellings, or standardize the name in your file. The offer is a suggestion, never applied on its own.',
  },
  {
    code: 'A04',
    anchor: 'problem-a04',
    title: 'a unit the app cannot trust',
    meaning: 'Two cases, one code. Error: a column mixes units — one cell in ng/mL in a column of MTM/mL — and the message names the rows. Warning: the unit differs from the marker\'s known scale, or the unit family cannot be classed.',
    action: 'Mixed units: make the column one unit and choose the file again — this blocks the analysis. A differing or unrecognised unit: use the marker\'s usual unit, or keep yours and read the "check the scales" note when you choose methods — this does not block.',
  },
  {
    code: 'A05',
    anchor: 'problem-a05',
    title: 'many vocabulary candidates',
    meaning: 'More than five vocabulary candidates exist for the marker column, so the offered list is truncated. The column is matched to the best candidate anyway.',
    action: 'Pick the right match from the vocabulary offer when the column is suggested, or name the marker as it is commonly known.',
  },
  {
    code: 'A06',
    anchor: 'problem-a06',
    title: 'a large file notice',
    meaning: 'The file has more than one million value rows, so the per-row checks take a moment. There is no size cap — the notice is informational.',
    action: 'Wait for the check; nothing to fix. Use the vocabulary and unit offers to keep the columns tidy.',
  },
  {
    code: 'A07',
    anchor: 'problem-a07',
    title: 'a mapped marker with no unit',
    meaning: 'After you confirm a marker\'s identity (accept the vocabulary offer), the column carries no unit, so the scale cannot be checked. It is reported once per column that maps this way.',
    action: 'Add a unit for that column, or accept the honest unknown — the scale will not be compared for it. The identity offer is never required; a column you leave unmapped is not checked by this code.',
  },
]

/** ONE entry per code, keyed by the wire code ('R03'). */
export const PROBLEM_HELP_BY_CODE: Readonly<Record<string, HelpProblemEntry>> =
  Object.fromEntries(PROBLEM_HELP.map(entry => [entry.code, entry]))

/** The anchor of one problem code's entry (the deep-link target). */
export const problemAnchorOf = (code: string): string =>
  PROBLEM_HELP_BY_CODE[code]?.anchor ?? `problem-${code.toLowerCase()}`

/** One code's catalogue entry (unknown code → `undefined`). */
export const catalogEntryOf = (code: string): ValidatorCatalogEntry | undefined =>
  VALIDATOR_CATALOG.find(entry => entry.code === code)

/**
 * The troubleshooting group of a code, from the catalogue:
 * `never` when the app never reports it (not applicable or holds by
 * construction), `error_or_warning` for the one dual code, else the single
 * severity. The group IS the catalogue's fact — never authored prose.
 */
export const problemGroupOf = (code: string): ProblemGroup => {
  const entry = catalogEntryOf(code)
  if (entry === undefined) return 'error'
  if (entry.applicability !== 'reported') return 'never'
  if (entry.severity === 'error_or_warning') return 'error_or_warning'
  return entry.severity
}

/** The groups in page order, with their displayed names. */
export const PROBLEM_GROUPS: readonly { group: ProblemGroup; label: string }[] = [
  { group: 'error', label: 'Errors — these block the analysis' },
  { group: 'warning', label: 'Warnings — reported, the file stays usable' },
  { group: 'error_or_warning', label: 'Error or warning — the message says which' },
  { group: 'never', label: 'Not reported by the app' },
]
