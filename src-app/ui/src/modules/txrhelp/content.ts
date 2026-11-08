/**
 * txrhelp content — the Help page's text as DATA.
 *
 * The content is typed (HelpSection / HelpProblemEntry in `types.ts`) and
 * contains no logic: the renderer (`pages/HelpPage.tsx`) and the tests are
 * the only consumers, so a wording change is a data change with no code
 * churn. Everything here is plain, accurate to the shipped behaviour
 * (DEC-5): it describes what the app DOES, not what a future version may
 * do; it carries no status, no progress wording and no unfinished-work
 * markers.
 *
 * The problem-code entries are the closed vocabulary of the server's file
 * validator (`src-app/server/src/modules/file_validator/types.rs`,
 * `ProblemCode::ALL` — 28 codes) with each code's meaning and fix, so the
 * intake screens' validation problems link to the matching entry.
 */

import type { HelpProblemEntry, HelpSection } from './types'

/** The Help page's sections, in page order (the TOC renders this order). */
export const HELP_SECTIONS: readonly HelpSection[] = [
  {
    id: 'overview',
    title: 'What TxResBench does',
    blocks: [
      {
        kind: 'paragraph',
        text: 'TxResBench is a desktop application for clinicians: it predicts treatment response from repeated blood biomarker measurements, on your own computer. You bring two tables — one row per patient with their outcome, and one row per blood draw and marker — the methods are trained or applied on your machine, and you see per-patient predictions for every method you ran.',
      },
      {
        kind: 'bullets',
        items: [
          'It runs entirely on your computer: no account, no sign-up, no queue.',
          'Every method runs in its own isolated environment on your machine.',
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
        kind: 'paragraph',
        text: 'The app walks you through four numbered steps, then shows the run and its results. The top bar always has New analysis (back to step 1), Models, History and Help.',
      },
      {
        kind: 'steps',
        items: [
          'Step 1 — Start. "What do you want to do?" offers the three ways in: "Predict with a pretrained model" (click "Add the patients to predict"), "Learn from my data" (click "Add my data") and "Use a model I saved" (click "Add the patients to predict").',
          'Step 2 — Your study (learn path only). "Tell us about your study": answer the six question groups (disease, treatment, what to predict, marker groups, draws before treatment, draws during treatment). The "N of M methods fit" panel updates as you answer; the answer narrows the methods you can choose.',
          'Step 3 — Your files. Learn: "Add your files" — a patients table and a measurements table, CSV or Excel, one card each. Pretrained or saved models: only the measurements of the patients you want predictions for. Every file is checked the moment you choose it; problems are listed under the card.',
          'Step 4 — Choose the methods and settings. Pick the methods (or models) with their checkboxes, set the run settings, then click "Run N methods". The screen shows each method\'s state live; you can leave it — the run continues and stays in History. When a method finishes its predictions appear: "See the results".',
          'Results. The heatmap table of patients × methods: one column per finished method, one row per patient, each entry a chance (0–100 %). Download all predictions as a CSV from the top-right.',
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
        text: 'Your files are plain CSV or Excel. The first row is the header; the columns can be in any order — the app finds the names for you, by name or by common spellings ("PatientID", "PFS Days", "day from start"). There are templates and full examples to download under each file card.',
      },
      {
        kind: 'caption',
        text: 'Patients table (one row per patient)',
      },
      {
        kind: 'table',
        head: ['Column', 'Required', 'Meaning'],
        rows: [
          ['patient_id', 'yes', 'your own patient code — the same code in both files'],
          ['pfs_days', 'yes', 'days until progression (or death), or until the last follow-up'],
          ['pfs_event', 'yes', '1 = progressed or died, 0 = still well at last follow-up'],
          ['os_days', 'yes', 'days until death, or until the last follow-up'],
          ['os_event', 'yes', '1 = died, 0 = alive at last follow-up'],
          ['responder, response_day', 'no', 'the response outcome: 1/0 and the day it was assessed'],
          ['age, sex, stage, ecog or cov_<name>', 'no', 'extra inputs some methods use; any other column is left out of the analysis'],
        ],
      },
      {
        kind: 'caption',
        text: 'Measurements table (one row per marker per blood draw)',
      },
      {
        kind: 'table',
        head: ['Column', 'Required', 'Meaning'],
        rows: [
          ['patient_id', 'yes', 'the patient code from the patients table'],
          ['day', 'yes', 'days from the start of treatment — day 0 is the first treatment day, draws before it are negative'],
          ['marker', 'yes', 'the marker\'s name as you write it, for example LDH or ctDNA'],
          ['value', 'yes', 'a number; a blank entry means no measurement of that marker at that draw (a blank is not a zero)'],
          ['unit', 'no', 'for example U/L — lets the app check the scale against the method\'s expectation'],
        ],
      },
      {
        kind: 'bullets',
        items: [
          'One row per draw per marker. The pair patient + day + marker must be unique; the same marker twice in one draw is a duplicate the app reports.',
          'Days are counted from the start of treatment: day 0 is the start, draws before treatment are negative (a draw at day −7 is a baseline). Measurement days outside −180 to 3650 raise a warning.',
          'Outcomes: pfs (progression or death) and os (death) each pair a time column with a 0/1 event column — both or neither; response pairs a 0/1 responder with the assessment day.',
          'If a column has no match for any known name, it is reported and left alone: it stays in your file and is not part of the analysis.',
          'Spelling variants of one marker (ldh / LDH) and partial name matches are offered to you as joins and vocabulary matches — suggestions only, never applied on their own.',
        ],
      },
      {
        kind: 'note',
        text: 'Example first rows: patients — P0001, 214, 1, 63, F · P0002, 380, 0, 71, M. Measurements — P0001, 0, LDH, 310, U/L · P0001, 28, LDH, 245, U/L · P0001, 0, ctDNA, 4.2, %.',
      },
    ],
  },
  {
    id: 'choosing-methods',
    title: 'Choosing methods',
    blocks: [
      {
        kind: 'paragraph',
        text: 'On step 4 you pick the published methods to run. Each row shows the method\'s name and publication, its group, an estimated time, and whether it can run on your file. The methods are grouped into four families: response call (a yes/no response call), response probability (a chance of responding), static risk and dynamic risk (a risk score at the horizon — the static ones read the measurements around the baseline, the dynamic ones re-read the markers over time and so need the later draws too).',
      },
      {
        kind: 'bullets',
        items: [
          'Can run — the method has everything it needs on every patient. Can run for some patients — it will run where the requirements are met; the row says who. Cannot run — the row is greyed out and a reason is shown (a marker missing from your file, not enough draws, extra inputs your file lacks, an outcome column your file lacks, or units that do not match).',
          'The estimate: each method\'s time is the benchmark\'s measured runtime, scaled to your file — about 150 patients and 4 CPUs are the reference, so more patients or fewer CPUs lengthen the estimate; the bottom bar sums your selection ("about 14 minutes in total on this computer"), packed onto the run-at-a-time lanes you choose.',
          'The app runs each method in its own sandbox: nothing you do here affects the machine, and the method cannot reach the network while it runs.',
          '"Run at a time" is how many methods run side by side; a lower number uses less memory and CPU. "Save the trained models" keeps each trained method so you can reuse it on new patients without re-training.',
          'The notice under the list is part of the app: the predictions are for research, not for deciding a patient\'s treatment.',
        ],
      },
    ],
  },
  {
    id: 'results',
    title: 'Reading results',
    blocks: [
      {
        kind: 'paragraph',
        text: 'The results page is a patient × method heatmap: one column per finished method, one row per patient, and each value that method\'s chance for that patient — 0 to 100 %, shaded from light to dark as the chance rises. Columns appear as methods finish, so a run that is still going grows the table live.',
      },
      {
        kind: 'bullets',
        items: [
          'The outcome tabs ("Progression or death by day N", "Death by day N", and "No response by day N" when the run answers a response) say what the chance is of; N is the run\'s horizon or response day.',
          'What a method predicts natively differs: some make a call, some a probability, some a risk score. The app turns each into the same chance column — when the run has data to calibrate on, the risk is recalibrated on your patients, and the method\'s provenance is shown per column ("How the chance is calculated"). A method that cannot be converted is honest about it instead of inventing a number.',
          'The Average column is the mean of the non-empty chances in that row; the Sort control orders the rows by it. The method filters (group, search) narrow the columns.',
          'A method that could not run is never silent: a banner names the missing thing and the other methods remain.',
          'Download all predictions (CSV) exports the table — patient, each method\'s chance and the per-method coverage — as a browser download. "Compare methods" puts the finished methods side by side, and "Save the models" / "Save this model" saves the trained methods from a finished run.',
          'You can leave the results while the run continues; every finished method is already in the table, and the history keeps the run.',
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
          'Pretrained models — the project\'s published models, checked against your measurements file on the "choose the models" screen: which ones can run on your file, what they were learned on, how they performed on other cohorts, and their time. Models not bundled with the app are downloaded once and then stay local.',
          'Saved models — the models you trained here, one section per training run, kept on your computer. Add the patients to predict and pick from them: the training data never has to be re-uploaded, and the app checks the new patients have the markers each model needs.',
          'Your models — the inventory of everything kept on this computer: model, method, what it predicts, decision day, where it was trained and when it was made. Rename, export or delete; "Open a model file" and the folder buttons open the files in your file manager.',
        ],
      },
      {
        kind: 'note',
        text: 'Use the same measurement columns (or their unit scale) as the training run whenever you can — a model needs the markers it was trained on, and the app warns when the scale does not match.',
      },
    ],
  },
  {
    id: 'history',
    title: 'Run history',
    blocks: [
      {
        kind: 'paragraph',
        text: 'History lists everything you ran on this computer, newest first: each card\'s title, status, date, what it used and how long it took. Open one and you get the run\'s files, settings, per-method versions and durations, and its actions — open the results, run again with the same settings, download the predictions, open the folder, or show the run log for troubleshooting.',
      },
      {
        kind: 'bullets',
        items: [
          'The search and the filter narrow the list (all runs / learned and predicted / predicted with a saved model / stopped or failed).',
          'The footer counts the runs and the space they use, and holds the two retention controls: stop keeping file copies, and clear all runs (with a confirmation before anything is removed).',
          'Deleting a run keeps the saved models, unless you remove them too — models have their own place.',
        ],
      },
    ],
  },
  {
    id: 'privacy',
    title: 'Privacy and the network',
    blocks: [
      {
        kind: 'paragraph',
        text: 'Your data never leaves your computer. There is no account, no analytics, no tracking, and nothing is uploaded: the files you drop, the runs, the trained models and the history are read and written locally only.',
      },
      {
        kind: 'bullets',
        items: [
          'The only network use is planned and narrow: downloading a method\'s analysis environment from the project\'s container registry (once per method; later runs reuse the cached copy), downloading a pretrained model that is not bundled with the app, and one silent check for an application update when the app starts.',
          'While a method runs, its sandbox has no network access at all.',
          'The app is made for single-user use on one machine: there is no cloud, no queue and no account anywhere between you and your results.',
        ],
      },
    ],
  },
  {
    id: 'data-location',
    title: 'Where your data lives',
    blocks: [
      {
        kind: 'paragraph',
        text: 'Everything the app keeps sits under one hidden folder in your home directory, named .txresbench: the run database, the per-run folders (analysis-<date>-<time>-<id> — your files, the trained models and the predictions), the saved models, the downloaded analysis environments and the app\'s cache. The result screens\' "open the folder" affordance reveals a run\'s folder in your file manager, and the models folder is shown on the Your models screen.',
      },
      {
        kind: 'note',
        text: 'Uninstalling the app does not delete this folder; remove runs from History (with their file copies) and delete the models you no longer need to reclaim space.',
      },
    ],
  },
  {
    id: 'troubleshooting',
    title: 'Troubleshooting',
    blocks: [
      {
        kind: 'paragraph',
        text: 'When a file has problems, the card under it lists one line per problem with the row number — each line\'s code below explains the meaning and the fix. Errors block the analysis; warnings are reported and do not stop you. Note: a "time_unit" column, if present, must read "days"; entries mean no measurement, not zero; and a header the app cannot recognise keeps everything downstream from resolving.',
      },
    ],
  },
]

/**
 * The problem-code entries — the validator's CLOSED 28-code vocabulary
 * (R01–R21 + A01–A07), one entry per code. The two tidy ids declared not
 * applicable (R01, R21) carry `level: "never"` and are shown as such:
 * they are part of the vocabulary the app models, but the app never
 * reports them.
 */
export const PROBLEM_HELP: readonly HelpProblemEntry[] = [
  {
    code: 'R01',
    anchor: 'problem-r01',
    title: 'R01 — tables present',
    level: 'never',
    meaning: 'The tidy benchmark rule "both tables are present". The app\'s request contract always carries the two files, so this code is never reported.',
    action: 'Nothing to do — the app never issues this one.',
  },
  {
    code: 'R02',
    anchor: 'problem-r02',
    title: 'R02 — required columns',
    level: 'error',
    meaning: 'A required column is missing from one of the tables: the patients table needs patient_id, pfs_days, pfs_event, os_days and os_event (responder/response_day are optional); the measurements table needs patient_id, day, marker and value (unit is optional).',
    action: 'Add the missing column to the file and choose the file again. The message names the column and the table (see the column tables in "Preparing your files").',
  },
  {
    code: 'R03',
    anchor: 'problem-r03',
    title: 'R03 — column types',
    level: 'error',
    meaning: 'A value has the wrong type for its column: day, value and the outcome times must be numbers; event and responder columns must be integers (0 or 1); ids, marker names and units are text even when they look like numbers.',
    action: 'Fix the named entry — the message repeats the offending value, for example a day written as "week 4" — then choose the file again.',
  },
  {
    code: 'R04',
    anchor: 'problem-r04',
    title: 'R04 — empty required entry',
    level: 'error',
    meaning: 'A value that must not be empty is empty: patient_id, day and marker in the measurements table, patient_id in the patients table, and a present time_unit value.',
    action: 'Fill the entry or remove the row; a blank value in the value column is the one blank that is allowed (there it means "no measurement").',
  },
  {
    code: 'R05',
    anchor: 'problem-r05',
    title: 'R05 — allowed values',
    level: 'error',
    meaning: 'An event or response column holds a value other than 0 or 1 (pfs_event, os_event, responder).',
    action: 'Code the column as 0/1 — no other spelling, not yes/no or a free text.',
  },
  {
    code: 'R06',
    anchor: 'problem-r06',
    title: 'R06 — outcome day below zero',
    level: 'error',
    meaning: 'An outcome time (pfs_days, os_days, response_day) is negative; outcome times count from the start of the treatment and cannot be negative.',
    action: 'Correct the day, or leave the entry empty when the outcome never occurred (paired with the event rule below).',
  },
  {
    code: 'R07',
    anchor: 'problem-r07',
    title: 'R07 — duplicate rows',
    level: 'error',
    meaning: 'patient_id repeats in the patients table, or the same (patient_id, day, marker) repeats in the measurements table — one row per patient, one row per draw per marker.',
    action: 'Remove the duplicate rows (the message lists every row of the group). Two draws at the same day are two rows with the same day — keep them distinct or merge them yourself.',
  },
  {
    code: 'R08',
    anchor: 'problem-r08',
    title: 'R08 — patient not in the patients table',
    level: 'error',
    meaning: 'A measurement row names a patient the patients table does not have (files mode only; the predict-only mode has no patients side, so it does not apply).',
    action: 'Check the spelling — one stray space or an extra digit is enough — or add the patient row to the patients table.',
  },
  {
    code: 'R09',
    anchor: 'problem-r09',
    title: 'R09 — values vs draws',
    level: 'never',
    meaning: 'The tidy rule "every value row\'s draw exists". In the app a draw is derived from the value rows themselves (the patient + day key), so the rule holds by construction; the app never reports it.',
    action: 'Nothing to do — this code cannot appear; a day that is not a number is reported as R03 instead.',
  },
  {
    code: 'R10',
    anchor: 'problem-r10',
    title: 'R10 — marker not described',
    level: 'error',
    meaning: 'A measurement row\'s marker spelling does not match any marker column the app recognised — case, spacing or punctuation differences are kept as separate spellings until you confirm a join.',
    action: 'Make the spelling identical across the file, or accept the join offer under the card ("ldh and LDH look the same — join them?").',
  },
  {
    code: 'R11',
    anchor: 'problem-r11',
    title: 'R11 — day agreement',
    level: 'never',
    meaning: 'The tidy rule "a value row\'s day agrees with its draw\'s day". The draw\'s day IS the value row\'s day (same key), so the rule holds by construction; the app never reports it.',
    action: 'Nothing to do — this code cannot appear.',
  },
  {
    code: 'R12',
    anchor: 'problem-r12',
    title: 'R12 — single time unit',
    level: 'error',
    meaning: 'A time_unit column is present and says something other than "days". The app\'s columns are always days; any other unit cannot be interpreted.',
    action: 'Change the time_unit value to "days" (one value in all rows), or remove the column — the day column stays in days either way.',
  },
  {
    code: 'R13',
    anchor: 'problem-r13',
    title: 'R13 — companion marker columns',
    level: 'error',
    meaning: 'A marker\'s companion columns are wrong: "<marker>__detected" must be 0/1, "<marker>__lod" must be ≥ 0, and the companion needs its base marker described in the file.',
    action: 'Fix the companion named in the message, or remove the column if your file does not use detection calls.',
  },
  {
    code: 'R14',
    anchor: 'problem-r14',
    title: 'R14 — few patients with an outcome',
    level: 'warning',
    meaning: 'Fewer than 10 patients carry a primary outcome, so a trained method has very little to learn from. The file is usable; the warning says what the best-covered outcome is.',
    action: 'More patients with outcomes, or keep the file and expect wide uncertainties — the warning is a note, not a block.',
  },
  {
    code: 'R15',
    anchor: 'problem-r15',
    title: 'R15 — derived draw without a patient',
    level: 'error',
    meaning: 'A measurement row\'s patient is not in the patients table (files mode) — the same class as R08, reported on the derived draw side.',
    action: 'Check the patient_id spelling against the patients table, or add the missing patient row.',
  },
  {
    code: 'R16',
    anchor: 'problem-r16',
    title: 'R16 — value row vs draw patient',
    level: 'never',
    meaning: 'The tidy rule "a value row names the same patient as its draw". The draw\'s patient IS the value row\'s patient (same key), so the rule holds by construction; the app never reports it.',
    action: 'Nothing to do — this code cannot appear.',
  },
  {
    code: 'R17',
    anchor: 'problem-r17',
    title: 'R17 — unknown day',
    level: 'never',
    meaning: 'The tidy rule "a draw\'s day is null exactly when the day source is unknown". The app\'s days always come from the file (never "unknown"), so the rule holds by construction; a non-numeric day is reported as R03 instead.',
    action: 'Nothing to do — this code cannot appear.',
  },
  {
    code: 'R18',
    anchor: 'problem-r18',
    title: 'R18 — unpaired time / event',
    level: 'error',
    meaning: 'An outcome column is only half-filled: pfs_days and pfs_event, os_days and os_event, and responder with response_day must each be both-or-neither.',
    action: 'Pair the columns: empty time with empty event (the outcome never happened), or a day with its 0/1 event.',
  },
  {
    code: 'R19',
    anchor: 'problem-r19',
    title: 'R19 — outcome at day 0',
    level: 'warning',
    meaning: 'A pfs_days or os_days value is exactly 0. It is reported as a warning because a day-0 event is unusual — not impossible (an immediate progression), but worth a look. (The response assessment day is not checked by this rule.)',
    action: 'Confirm the day; if the event happened before the treatment started, the row is probably wrong.',
  },
  {
    code: 'R20',
    anchor: 'problem-r20',
    title: 'R20 — measurement day outside the range',
    level: 'warning',
    meaning: 'A measurement day is outside −180 to 3650 days from the start of treatment. The row is kept; the app only warns because such a draw is unusual.',
    action: 'Check the day\'s sign and scale (months are not days) — the app reports the row so you can decide.',
  },
  {
    code: 'R21',
    anchor: 'problem-r21',
    title: 'R21 — preview consistent',
    level: 'never',
    meaning: 'The tidy rule "the preview files agree with the data". The app has no preview files — any preview is generated from your rows by the run — so the rule is declared not applicable and never reported.',
    action: 'Nothing to do — the app never issues this one.',
  },
  {
    code: 'A01',
    anchor: 'problem-a01',
    title: 'A01 — no recognizable header',
    level: 'error',
    meaning: 'None of the file\'s columns matches a known name, so the app cannot tell the header row from the data — usually a title row above the header or a sheet with the table further down.',
    action: 'Make row 1 the header with the column names (see "Preparing your files"), or pick the sheet / start of the table that has the header.',
  },
  {
    code: 'A02',
    anchor: 'problem-a02',
    title: 'A02 — no outcome column',
    level: 'error',
    meaning: 'The patients table carries none of the outcome column sets (pfs, os, or responder / response_day), so no analysis can be built on it.',
    action: 'Add at least one outcome column set: pfs_days + pfs_event, os_days + os_event, or responder + response_day.',
  },
  {
    code: 'A03',
    anchor: 'problem-a03',
    title: 'A03 — marker spellings that look the same',
    level: 'warning',
    meaning: 'Two or more spellings of one marker appear in the measurements file (ldh and LDH, or ctDNA and ct-DNA). Until you decide, they are treated as separate columns.',
    action: 'Accept the join offer under the card ("join them?") to merge the spellings, or standardize the name in your file — the offer is a suggestion, never applied on its own.',
  },
  {
    code: 'A04',
    anchor: 'problem-a04',
    title: 'A04 — unit differs from the expected scale',
    level: 'warning',
    meaning: 'The value column\'s unit does not match the marker\'s known unit family (for example a mass unit where the method expects a concentration), or the unit family cannot be classed.',
    action: 'Use the marker\'s usual unit (the warning names the marker and the scale) or keep your unit and read the "check the scales" note when you choose methods — it is a warning, not a block.',
  },
  {
    code: 'A05',
    anchor: 'problem-a05',
    title: 'A05 — many vocabulary candidates',
    level: 'warning',
    meaning: 'More than five vocabulary candidates exist for the marker column and the offered list is truncated. The column is matched to the best candidate anyway.',
    action: 'Pick the right match from the vocabulary offer when the column is suggested, or name the marker as it is commonly known.',
  },
  {
    code: 'A06',
    anchor: 'problem-a06',
    title: 'A06 — large file notice',
    level: 'warning',
    meaning: 'The file has more than one million rows; the per-row checks take a moment. There is no size cap — the notice is informational.',
    action: 'Wait for the check; nothing to fix. Use the per-column vocabulary / units offers to keep the columns tidy.',
  },
  {
    code: 'A07',
    anchor: 'problem-a07',
    title: 'A07 — unit absent',
    level: 'warning',
    meaning: 'A marker column carries no unit, and the app cannot infer the unit family for it (it knows none of the column\'s values).',
    action: 'Add a unit column value so the scale can be checked, or accept the honest unknown — the method row will say "units do not match" where the scale matters.',
  },
]

/** ONE entry per code, keyed by the wire code ('R03'). */
export const PROBLEM_HELP_BY_CODE: Readonly<Record<string, HelpProblemEntry>> =
  Object.fromEntries(PROBLEM_HELP.map(entry => [entry.code, entry]))

/** The anchor of one problem code's entry (the deep-link target). */
export const problemAnchorOf = (code: string): string =>
  PROBLEM_HELP_BY_CODE[code]?.anchor ?? `problem-${code.toLowerCase()}`
