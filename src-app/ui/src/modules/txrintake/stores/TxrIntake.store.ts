/**
 * TxrIntake — the intake state store (PROV-UI-INTAKE-2, ITEM-3).
 *
 * ONE global lazy store owns the snapshot the user builds across screens A
 * (Start), B (Your study), C (Your files) and N (Add the patients to predict):
 * `IntakeSnapshot` (types.ts) + the small persistence slice. Later screens
 * never rebuild the intake state — ui-run's screen E, ui-models' screens D/I
 * read the same store, and the module barrel (`index.ts`) is the single
 * import point.
 *
 * Contract notes:
 *
 * - Suggestions are never auto-applied (the validator's own rule,
 *   PROV-FV-5/7): `acceptJoin` / `acceptVocab` move a pending offer into the
 *   CONFIRMED lists (`joins` / `mapping`), `rejectJoin` / `rejectVocab` drop
 *   the offer without recording it, and BOTH remove the offer from the
 *   owning file's pending list (a resolved offer is no longer a question).
 * - ONE `ValidationResponse` travels as `validation` (the E/D/I screens read
 *   `validation.inventory` as their single eligibility object). It is set
 *   only by `applyValidation` (stale-guarded against the joins/mapping/
 *   parameters the response was computed FOR) and nulled on every mutation
 *   of those inputs. It is NEVER persisted — a reload gives null (DEC-4,
 *   OWNER-6, TEST-INT-26).
 * - Persistence is the partialize below: the small fields survive a reload,
 *   the `ParsedTable` payloads and the inspect/validate bodies are memory
 *   only. The file cards' reload state ("name, choose the file again") is
 *   `fileRecalls` — a name + prepared flag per slot, with the parsed payload
 *   dropped (the snapshot's file slots are null again after rehydration).
 * - `fileRecalls` is the store's own small convenience surface; it is NOT
 *   part of `IntakeSnapshot` (the type contract stays the plan's).
 */
import { createJSONStorage } from 'zustand/middleware'
import { defineStore, registerLazyStore } from '@txresbench/framework/store-kit'
import type {
  MarkerMapping,
  ParsedTable as EngineParsedTable,
  TxrRunInput,
  ValidationResponse,
} from '@/api-client/types'
import type { ParsedTable } from '@/lib/txr-files/types'
import type {
  IntakeIntent,
  IntakeSnapshot,
  JoinOffer,
  LoadedFile,
  StudyAnswers,
  VocabOffer,
} from '../types'
import type { ColumnRenameOffer } from '../types'
import { renamedTable } from '../lib/flow'

/** The three file slots of the snapshot (screen C's two, screen N's one). */
export type FileSlot = 'patients' | 'measurements' | 'predictMeasurements'

/**
 * What remains of an adopted file after a reload: its name and the prepared
 * flag. The card renders "name, choose the file again" from this until the
 * user re-drops the file (DEC-4).
 */
export interface FileRecall {
  name: string
  prepared: boolean
}

/** The recall map kept per file slot (all three are always present). */
export type FileRecalls = Record<FileSlot, FileRecall | null>

/**
 * The inputs a validation response was computed against. `applyValidation`
 * stores the response only when the CURRENT state still equals this key —
 * a mutation that happened while the request was in flight leaves
 * `validation` null instead of resurrecting a stale response.
 */
export interface IntakeValidationKey {
  joins: JoinOffer[]
  mapping: MarkerMapping[]
  parameters: IntakeSnapshot['parameters']
}

/** A per-file card-state patch (the card surface on C/N and the E-screen slots). */
export type FileCardPatch = Partial<
  Pick<LoadedFile, 'inspection' | 'problems' | 'prepared' | 'joinOffers' | 'vocabOffers' | 'columnOffers'>
>

/** The store's data fields (the `IntakeSnapshot` + the recall map). */
export interface TxrIntakeState extends IntakeSnapshot {
  fileRecalls: FileRecalls
  /**
   * The A-screen "Try the example data" was the source of the files now in
   * the cards (qa-fixes ITEM-6, F6) — a presentation fact, never part of
   * `IntakeSnapshot` (the state contract stays the flow's); the C screen
   * announces "example data loaded" while it is true, and ANY adoption or
   * removal of a file clears it (the cards then hold the user's own files).
   */
  exampleLoaded: boolean
  /**
   * The per-slot example fact (qa-fixes3 ITEM-4): WHICH cards hold the
   * example set (the badge + the "Clear example" action need the slot
   * granularity — the N screen's predict card and the C screen's two
   * cards announce separately). Written by the same actions that write
   * `exampleLoaded`; `exampleLoaded` stays the aggregated boolean the
   * qa-fixes2 banner reads.
   */
  exampleSlots: Record<FileSlot, boolean>
  /**
   * The ITEM-3 set handoff (qa-fixes3 ITEM-4): the id of the "Example
   * models" set the reuse-path example flow ensured — the saved-models
   * screen ticks that set's rows once its saved list holds them, then
   * clears the fact. Same class as `exampleLoaded`: a handoff fact, never
   * part of `IntakeSnapshot`, never persisted (a reload forgets it — the
   * user can call "Use example" again).
   */
  pendingExampleSetId: string | null
}

/**
 * The persisted slice: the SMALL fields only (DEC-4). The `ParsedTable`
 * payloads, `FileInspection` and `ValidationResponse` bodies are never
 * written — a reload shows the answers + file names and the user re-drops
 * the files.
 */
export interface PersistedIntake {
  intent: IntakeIntent
  mode: IntakeSnapshot['mode']
  study: StudyAnswers
  fileRecalls: FileRecalls
  joins: JoinOffer[]
  mapping: MarkerMapping[]
  parameters: IntakeSnapshot['parameters']
}

/** The four board decision-day values (the B "last draw" options, DEC-5). */
export const DECISION_DAYS = [28, 42, 56, 84] as const

/**
 * Snap an arbitrary day to the nearest of the four board values (ties go to
 * the earlier day). The B select and the E run default only ever carry a
 * board value; a config-fed value outside the set (an engine default, a
 * previous run's setting) is brought onto the same grid the screens render.
 */
function snapDecisionDay(day: number): number {
  let best: number = DECISION_DAYS[0]
  for (const candidate of DECISION_DAYS) {
    if (Math.abs(candidate - day) < Math.abs(best - day)) best = candidate
  }
  return best
}

/** Birth study answers — every question unanswered (the user may skip B). */
const EMPTY_STUDY: StudyAnswers = {
  disease: null,
  treatment: null,
  outcome: null,
  markerGroups: null,
  beforeTreatment: null,
  drawsDuringTreatment: null,
  lastDrawDay: null,
}

const BIRTH_FILE_RECALLS: FileRecalls = {
  patients: null,
  measurements: null,
  predictMeasurements: null,
}

const BIRTH_EXAMPLE_SLOTS: Record<FileSlot, boolean> = {
  patients: false,
  measurements: false,
  predictMeasurements: false,
}

/** Whether any slot still holds the example set (the aggregate banner fact). */
function anyExampleSlot(slots: Record<FileSlot, boolean>): boolean {
  return slots.patients || slots.measurements || slots.predictMeasurements
}

/** Replace one slot's file (all three slots always present in the result). */
function withFile(
  s: TxrIntakeState,
  slot: FileSlot,
  file: LoadedFile | null,
): Pick<TxrIntakeState, FileSlot> {
  return {
    patients: slot === 'patients' ? file : s.patients,
    measurements: slot === 'measurements' ? file : s.measurements,
    predictMeasurements: slot === 'predictMeasurements' ? file : s.predictMeasurements,
  }
}

/** Drop a resolved join offer from one file's pending list. */
function withoutJoinOffer(file: LoadedFile | null, key: string): LoadedFile | null {
  if (!file) return file
  const next = file.joinOffers.filter(o => o.key !== key)
  return next.length === file.joinOffers.length ? file : { ...file, joinOffers: next }
}

/** Drop a resolved vocabulary offer from one file's pending list. */
function withoutVocabOffer(file: LoadedFile | null, key: string): LoadedFile | null {
  if (!file) return file
  const next = file.vocabOffers.filter(o => o.key !== key)
  return next.length === file.vocabOffers.length ? file : { ...file, vocabOffers: next }
}

/** Order-sensitive equality of the validation key (the page sends its snapshot). */
function sameValidationKey(current: TxrIntakeState, at: IntakeValidationKey): boolean {
  const sameEntries = <T,>(a: T[], b: T[]): boolean =>
    a.length === b.length && a.every((entry, i) => JSON.stringify(entry) === JSON.stringify(b[i]))
  return (
    sameEntries(current.joins, at.joins) &&
    sameEntries(current.mapping, at.mapping) &&
    JSON.stringify(current.parameters) === JSON.stringify(at.parameters)
  )
}

// Guarded persistence storage (the ConfigClient / WorkbenchLayout precedent):
// localStorage throws in locked-down contexts (private-mode quota, disabled
// storage, sandboxed iframe). Probe once and fall back to in-memory so store
// creation never takes the app down; the state simply won't survive a reload
// there.
const safeStorage = createJSONStorage(() => {
  try {
    const probe = '__txr_intake_ls_probe__'
    window.localStorage.setItem(probe, probe)
    window.localStorage.removeItem(probe)
    return window.localStorage
  } catch {
    const mem = new Map<string, string>()
    return {
      getItem: (name: string) => mem.get(name) ?? null,
      setItem: (name: string, value: string) => {
        mem.set(name, value)
      },
      removeItem: (name: string) => {
        mem.delete(name)
      },
    }
  }
})

const TxrIntakeDef = defineStore('TxrIntake', {
  persist: {
    name: 'txr-intake-storage',
    storage: safeStorage,
    partialize: (s: TxrIntakeState): PersistedIntake => ({
      intent: s.intent,
      mode: s.mode,
      study: s.study,
      fileRecalls: s.fileRecalls,
      joins: s.joins,
      mapping: s.mapping,
      parameters: s.parameters,
    }),
    merge: (persisted, current) => {
      const p = (persisted ?? {}) as Partial<PersistedIntake>
      return {
        ...current,
        ...(p.intent !== undefined ? { intent: p.intent } : {}),
        ...(p.mode !== undefined ? { mode: p.mode } : {}),
        ...(p.study !== undefined ? { study: p.study } : {}),
        ...(p.fileRecalls !== undefined ? { fileRecalls: p.fileRecalls } : {}),
        ...(p.joins !== undefined ? { joins: p.joins } : {}),
        ...(p.mapping !== undefined ? { mapping: p.mapping } : {}),
        ...(p.parameters !== undefined ? { parameters: p.parameters } : {}),
      }
    },
  },
  state: {
    intent: 'train' as IntakeIntent,
    mode: 'study' as IntakeSnapshot['mode'],
    study: { ...EMPTY_STUDY },
    patients: null as LoadedFile | null,
    measurements: null as LoadedFile | null,
    predictMeasurements: null as LoadedFile | null,
    joins: [] as JoinOffer[],
    mapping: [] as MarkerMapping[],
    parameters: { decision_day: 56, baseline_max_day: 0 },
    validation: null as ValidationResponse | null,
    fileRecalls: { ...BIRTH_FILE_RECALLS },
    exampleLoaded: false,
    exampleSlots: { ...BIRTH_EXAMPLE_SLOTS },
    pendingExampleSetId: null as string | null,
  },
  actions: (set, get) => {
    /** The state snapshot the current validation is STILL valid against. */
    const validationKey = (s: TxrIntakeState): IntakeValidationKey => ({
      joins: s.joins,
      mapping: s.mapping,
      parameters: s.parameters,
    })

    return {
      /** The A-card path choice; the mode follows (train → study, the rest → predict). */
      setIntent: (intent: IntakeIntent) => {
        set({
          intent,
          mode: intent === 'train' ? 'study' : 'predict',
        })
      },

      /** Merge one B answer group change (any field; unanswered fields stay null). */
      patchStudy: (patch: Partial<StudyAnswers>) => {
        set(s => ({ study: { ...s.study, ...patch } }))
      },

      /**
       * Adopt a dropped file for a slot. The file's pending offers are reset
       * (a fresh drop has no offers — the validate pass derives them next),
       * the slot's recall is kept, and the current validation is invalidated.
       * The adoption ALSO clears the example-data fact (the cards then hold
       * the user's own files — ITEM-6 F6's banner announces only the example
       * that is still there).
       */
      adoptFile: (slot: FileSlot, file: LoadedFile) => {
        set(s => {
          const exampleSlots = { ...s.exampleSlots, [slot]: false }
          return {
            ...withFile(s, slot, { ...file, joinOffers: [], vocabOffers: [], columnOffers: [] }),
            fileRecalls: {
              ...s.fileRecalls,
              [slot]: { name: file.source.name, prepared: file.prepared },
            },
            validation: null,
            exampleSlots,
            exampleLoaded: anyExampleSlot(exampleSlots),
          }
        })
      },

      /**
       * Adopt the example table for a slot (qa-fixes3 ITEM-4): the same
       * contract as `adoptFile` (offers reset, recall kept, validation
       * invalidated) with the slot MARKED as the example set — the card's
       * "Example" badge, the screen's example banner and the "Clear
       * example" action read the flag.
       */
      adoptExampleFile: (slot: FileSlot, file: LoadedFile) => {
        set(s => {
          const exampleSlots = { ...s.exampleSlots, [slot]: true }
          return {
            ...withFile(s, slot, { ...file, joinOffers: [], vocabOffers: [], columnOffers: [] }),
            fileRecalls: {
              ...s.fileRecalls,
              [slot]: { name: file.source.name, prepared: file.prepared },
            },
            validation: null,
            exampleSlots,
            exampleLoaded: anyExampleSlot(exampleSlots),
          }
        })
      },

      /** Remove a slot's file (recall cleared too; validation invalidated). */
      removeFile: (slot: FileSlot) => {
        set(s => {
          const exampleSlots = { ...s.exampleSlots, [slot]: false }
          return {
            ...withFile(s, slot, null),
            fileRecalls: { ...s.fileRecalls, [slot]: null },
            validation: null,
            exampleSlots,
            exampleLoaded: anyExampleSlot(exampleSlots),
          }
        })
      },

      /**
       * "Clear example" (qa-fixes3 ITEM-4): remove every slot that holds
       * the example set, forget the confirmed joins/mappings the example's
       * validation built (they describe the example's columns, never the
       * user's), return the screens to their empty state and drop the
       * example-set handoff. A user's own file in a slot is NEVER touched.
       */
      clearExamples: () => {
        set(s => {
          const cleared: Pick<TxrIntakeState, FileSlot> = {
            patients:
              s.exampleSlots.patients === true
                ? null
                : s.patients,
            measurements:
              s.exampleSlots.measurements === true ? null : s.measurements,
            predictMeasurements:
              s.exampleSlots.predictMeasurements === true ? null : s.predictMeasurements,
          }
          const fileRecalls: FileRecalls = { ...s.fileRecalls }
          for (const slot of ['patients', 'measurements', 'predictMeasurements'] as const) {
            if (s.exampleSlots[slot] === true) fileRecalls[slot] = null
          }
          // The joins/mapping describe MEASUREMENT columns: clear them only
          // when the example's measurement table left the flow (a mixed
          // example patients + user-own measurements state keeps its
          // confirmations; the pure example state adds none anyway — its
          // synthetic markers carry no spelling variants and no ladder
          // match).
          const exampleMeasured =
            s.exampleSlots.measurements === true ||
            s.exampleSlots.predictMeasurements === true
          return {
            ...cleared,
            fileRecalls,
            joins: exampleMeasured ? [] : s.joins,
            mapping: exampleMeasured ? [] : s.mapping,
            validation: null,
            exampleSlots: { ...BIRTH_EXAMPLE_SLOTS },
            exampleLoaded: false,
            pendingExampleSetId: null,
          }
        })
      },

      /** The ITEM-3 example-set handoff (qa-fixes3 ITEM-4). */
      setPendingExampleSet: (setId: string | null) => {
        set({ pendingExampleSetId: setId })
      },

      /**
       * Accept one column-renaming suggestion (qa-fixes ITEM-6, F2): the
       * file's table is rewritten with the canonical column spelling, the
       * offer leaves the card's pending list, and the inspection + validation
       * are invalidated so the next round reads the file as if its header
       * carried the canonical name (the re-inspect re-resolves the roles and
       * the re-validate re-derives the problems from the canonical columns).
       * The rename is stored IN the table (the preview shows the canonical
       * spelling; the wire tables the inspect / validate posts carry it) —
       * no separate rename registry to drift.
       */
      renameColumn: (slot: FileSlot, offer: ColumnRenameOffer) => {
        set(s => {
          const file = s[slot]
          if (!file) return {}
          const next: LoadedFile = {
            ...file,
            table: renamedTable(file.table, offer),
            inspection: null,
            problems: [],
            prepared: false,
            columnOffers: file.columnOffers.filter(o => o.from !== offer.from),
          }
          return {
            ...withFile(s, slot, next),
            validation: null,
          }
        })
      },

      /**
       * "Not now" for one column-renaming suggestion (qa-fixes ITEM-6, F2):
       * the offer leaves the card's pending list and no rename is applied.
       * The validation stays (a "not now" changes no validated input — the
       * accepted side of the offer is the rename, which DOES re-validate);
       * the owning page's session `dismissed` set keeps the suggestion from
       * re-offering on the next round.
       */
      rejectColumnOffer: (slot: FileSlot, from: string) => {
        set(s => {
          const file = s[slot]
          if (!file) return {}
          const next: LoadedFile = {
            ...file,
            columnOffers: file.columnOffers.filter(o => o.from !== from),
          }
          return {
            ...withFile(s, slot, next),
          }
        })
      },

      /**
       * Write the per-file card state (inspect result, problems, offers,
       * preparedness) the drop flow derives. Deliberately does NOT null
       * `validation`: these writes are the OUTPUT of the current validation
       * (or of an inspect that preceded it), not a change to its inputs — a
       * file REPLACEMENT (adoptFile) is what invalidates.
       */
      patchFile: (slot: FileSlot, patch: FileCardPatch) => {
        set(s => {
          const file = s[slot]
          if (!file) return {}
          const next: LoadedFile = { ...file, ...patch }
          return {
            ...withFile(s, slot, next),
            ...(patch.prepared !== undefined
              ? {
                  fileRecalls: {
                    ...s.fileRecalls,
                    [slot]: { name: next.source.name, prepared: patch.prepared },
                  },
                }
              : {}),
          }
        })
      },

      /**
       * Confirm a spelling join: the offer's variants become one column
       * key. Idempotent on the key; the offer leaves every pending list; the
       * validation is invalidated (the join changes the validated inputs).
       */
      acceptJoin: (offer: JoinOffer) => {
        set(s => ({
          joins: s.joins.some(j => j.key === offer.key)
            ? s.joins
            : [...s.joins, offer],
          patients: withoutJoinOffer(s.patients, offer.key),
          measurements: withoutJoinOffer(s.measurements, offer.key),
          predictMeasurements: withoutJoinOffer(s.predictMeasurements, offer.key),
          validation: null,
        }))
      },

      /** "Not now" — the offer is dropped, no join is recorded. */
      rejectJoin: (offer: JoinOffer) => {
        set(s => ({
          patients: withoutJoinOffer(s.patients, offer.key),
          measurements: withoutJoinOffer(s.measurements, offer.key),
          predictMeasurements: withoutJoinOffer(s.predictMeasurements, offer.key),
          validation: null,
        }))
      },

      /**
       * Confirm a vocabulary match: the column key is mapped to the
       * vocabulary marker id (replacing a previous mapping of the same key).
       * The offer leaves every pending list; validation invalidated.
       */
      acceptVocab: (offer: VocabOffer) => {
        set(s => {
          const entry: MarkerMapping = { key: offer.key, marker_id: offer.match.marker_id }
          const mapping = s.mapping.some(m => m.key === offer.key)
            ? s.mapping.map(m => (m.key === offer.key ? entry : m))
            : [...s.mapping, entry]
          return {
            mapping,
            patients: withoutVocabOffer(s.patients, offer.key),
            measurements: withoutVocabOffer(s.measurements, offer.key),
            predictMeasurements: withoutVocabOffer(s.predictMeasurements, offer.key),
            validation: null,
          }
        })
      },

      /** "Not this one" — the offer is dropped and the key stays UNMAPPED. */
      rejectVocab: (offer: VocabOffer) => {
        set(s => ({
          patients: withoutVocabOffer(s.patients, offer.key),
          measurements: withoutVocabOffer(s.measurements, offer.key),
          predictMeasurements: withoutVocabOffer(s.predictMeasurements, offer.key),
          validation: null,
        }))
      },

      /**
       * Change the analysis parameters. `decision_day` snaps to the nearest
       * of the four board values (DEC-5); `baseline_max_day` is always 0 —
       * the contract rule (baseline = day <= baseline_max_day) and no board
       * exposes a control for it, so the field is accepted for shape
       * compatibility and never stored different.
       */
      patchParameters: (patch: Partial<IntakeSnapshot['parameters']>) => {
        set(s => ({
          parameters: {
            decision_day:
              patch.decision_day !== undefined && Number.isFinite(patch.decision_day)
                ? snapDecisionDay(patch.decision_day)
                : s.parameters.decision_day,
            baseline_max_day: 0,
          },
          validation: null,
        }))
      },

      /**
       * Store the ONE validation response — only when the current
       * joins/mapping/parameters still equal the key the page validated
       * against. A mutation in flight leaves validation null.
       */
      applyValidation: (response: ValidationResponse, at: IntakeValidationKey) => {
        set(s => {
          if (!sameValidationKey(s, at)) return {}
          return { validation: response }
        })
      },

      /** Back to the birth state (intent unset, no files, nothing confirmed). */
      reset: () => {
        set({
          intent: 'train',
          mode: 'study',
          study: { ...EMPTY_STUDY },
          patients: null,
          measurements: null,
          predictMeasurements: null,
          joins: [],
          mapping: [],
          parameters: { decision_day: 56, baseline_max_day: 0 },
          validation: null,
          fileRecalls: { ...BIRTH_FILE_RECALLS },
          exampleLoaded: false,
          exampleSlots: { ...BIRTH_EXAMPLE_SLOTS },
          pendingExampleSetId: null,
        })
      },

      /**
       * The current validation key — the captures a page hands to
       * `applyValidation` with the response.
       */
      currentValidationKey: (): IntakeValidationKey => validationKey(get()),
    }
  },
})

export const useTxrIntakeStore = TxrIntakeDef.store

/**
 * The reactive store proxy — the direct handle consumers import.
 * `registerLazyStore` builds it ONCE and self-registers it under the name
 * `'TxrIntake'` (module-system lifecycle: init on first access, ref-counted
 * destroy).
 */
export const TxrIntake = registerLazyStore(TxrIntakeDef)

/**
 * The pure state → engine-shape builder (the ONE place the intake state is
 * rendered into the engine's request, CONS-UI-INTAKE-8 / PROV-EE-2): the
 * decoded tables from the snapshot's file slots, the confirmed joins and
 * mapping passed through, `keep_copies: true` (ui-run overrides it with the
 * history-store preference).
 *
 * Measurements rule: `measurements` is REQUIRED by the request type and
 * carries "train and predict in one file, or the train table when a
 * separate predict file is given" — so a predict-mode snapshot (screen N)
 * fills it with the N-screen table, and `predict_measurements` carries the
 * same table for the engine's reuse/pretrained contract (EXAMPLE-EE-7:
 * a reuse run posts `predict_measurements`; the engine plan's own
 * "measurements required" text and its "predict_measurements only"
 * example diverge — recorded for RECONCILE). No measurements file adopted
 * at all is a caller error — the engine requires the table, so the builder
 * says so instead of emitting an undefined wire field.
 */
export function buildTxrRunInput(s: IntakeSnapshot): TxrRunInput {
  return {
    patients: toEngineTable(s.patients?.table),
    measurements: toEngineTable(requireMeasurements(s)),
    predict_measurements: toEngineTable(s.predictMeasurements?.table),
    joins: s.joins,
    mapping: s.mapping,
    keep_copies: true,
  }
}

/** The measurements table the run will consume (train, or the predict file). */
function requireMeasurements(s: IntakeSnapshot): ParsedTable {
  const table = s.measurements?.table ?? s.predictMeasurements?.table
  if (!table) {
    throw new Error(
      'TxrIntake: no measurements file adopted — a file must be validated before the run input is built',
    )
  }
  return table
}

/**
 * The lib's decoded `ParsedTable` crossing into the generated engine types.
 * The generated client's `ParsedTable.rows` is `string | null[][]` — an
 * openapi-generator artifact of the server's `Vec<Vec<Option<String>>>` —
 * while the decode library's is `(string | null)[][]`; the wire bytes are
 * identical (`[[null, "…"], …]`), so this is a type-level bridge over a
 * provider-generated defect, never a reshape. Recorded in DRIFT-1 ITEM-3
 * for the provider regen (the same artifact meets ITEM-6 at
 * `FileInspectionRequest.table` / `ValidationRequest`).
 */
function toEngineTable(table: ParsedTable): EngineParsedTable
function toEngineTable(table: ParsedTable | undefined): EngineParsedTable | undefined
function toEngineTable(table: ParsedTable | undefined): EngineParsedTable | undefined {
  if (table === undefined) return undefined
  return table as unknown as EngineParsedTable
}
