# txrintake

The intake module of the TxResBench app: screens A (Start), B (Your study),
C (Your files) and N (Add the patients to predict) — the four screens a
clinician walks before the method/model choice screens (E, D, I), which
`ui-run` and `ui-models` build.

Every answer and every adopted file lives in ONE snapshot (the `TxrIntake`
store, PROV-UI-INTAKE-2), so no later screen rebuilds what the user already
answered or dropped, and ui-run / ui-models consume the intake state through
this module's barrel instead of a second implementation.

## Routes

| screen | board | route | what the user does |
|---|---|---|---|
| A Start | `Start.dc.html` | `/` | picks one of the three paths (pretrained / learn from my data / saved models) |
| B Your study | `Criteria.dc.html` | `/study` | answers the six question groups; the live "N of M methods fit" panel updates as they answer |
| C Your files | `Files.dc.html` | `/files` | drops the patients + measurements files; per-row problem reports, join and vocabulary offers |
| N Add the patients to predict | `PredictFiles.dc.html` | `/predict-files` | drops the measurements file the pretrained/saved models run on |

All four routes are `requiresAuth: true` under the shell layout
(`TxrLayoutDef` from `txrshell/module.tsx`). The module owns `/` — the
`txrshell` scaffold route for `/` is removed on the same branch (route
handoff, recorded in `txrshell/module.tsx`); the shell keeps `/models`,
`/history`, `/help`.

## The E/D/I route conventions

The intake screens' Continue / "see them" links navigate to the choice
screens, whose routes the sibling modules own. The paths are declared once
here (`ROUTE_CONVENTIONS` in `module.tsx`) so `ui-run`'s and `ui-models`'s
plans bind the same strings:

| route | screen | owner |
|---|---|---|
| `/choose-methods` | E — choose methods and settings | ui-run |
| `/pretrained-models` | D — choose pretrained models | ui-models |
| `/saved-models` | I — choose saved models | ui-models |

## The intake state contract

`types.ts`, re-exported by the barrel (`index.ts`):

| type | meaning |
|---|---|
| `IntakeIntent` | the A-card path: `'pretrained'` / `'train'` / `'reuse'`; sets the snapshot's `mode` |
| `StudyAnswers` | the six B question groups (disease, treatment, outcome, marker groups, before-treatment, draws during treatment, last draw day) |
| `LoadedFile` | one adopted file: the decoded table, the inspect result, the problem list, the ready flag and the pending offers |
| `JoinOffer` / `VocabOffer` | a confirmed spelling join / a confirmed vocabulary match — suggestions only, never auto-applied (the validator's own rule) |
| `IntakeSnapshot` | the whole state ui-run and ui-models read: intent + mode + answers + the three file slots + confirmed joins/mapping + parameters + the ONE `ValidationResponse` |

Every count the screens render is computed from the structured fields or
the live provider response — the boards' example numbers are design
examples, never data (FLOW.md). Persistence is the store's partialize
(DEC-4): the small fields (intent, mode, answers, file names + prepared
flags, joins, mapping, parameters) survive a reload; the parsed table
payloads and the inspect/validate bodies are memory only, so a reload shows
the file cards' "name, choose the file again" state and the user re-drops
the files.

## The shared file surface (PROV-UI-INTAKE-5)

One card surface serves the three file mounts: screen C's patients and
measurements cards, screen N's measurements card, and ui-run's E-screen
"Change files" / predict slots (DEC-21 — E never builds a second picker).
The barrel re-exports `TxrFileCard` (the composed card) and its parts
(`TxrFileDrop`, `TxrProblemList`, `TxrJoinOffer`, `TxrVocabOffer`); a host
mounts `TxrFileCard` with the PROV-UI-INTAKE-5 props — `kind`, `mode`
(`'study'` for the C cards, `'predict'` for N), `file`, `busy`, `error`,
`onPick`, `onRemove`, the four offer answers and the two download
callbacks — and wires the `TxrIntake` store actions, exactly as the intake
pages do. The card is controlled (no flow state inside); its one store read
is the shared `validation` slot, so any of the mounts renders the same
validation facts the E/D/I screens read.

## Provider contracts

The module consumes only generated / provider-owned surfaces: the browser
decode library `@/lib/txr-files` (`ParsedTable` — one decode library for
both screens and the engine, never re-implemented), the generated
`@/api-client/types` (inspect/validate/eligibility responses, `TxrRunInput`
request types), and the `ui-list` reason/copy formatters. The OpenAPI
regen is the providers' (method-catalogue, file-validator,
execution-engine); this module never regenerates and never commits the
generated files.
