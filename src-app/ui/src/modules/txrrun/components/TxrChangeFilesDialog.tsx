/**
 * TxrChangeFilesDialog — the E screen's "Change files" dialog (ITEM-6,
 * DEC-9, PROV-UI-RUN-4; the provider's declared host surface,
 * PROV-UI-INTAKE-5 / EXAMPLE-INT-8).
 *
 * The dialog keeps the E context (the user stays on Step 4) and hosts the
 * intake's `TxrFileCard` per slot the run's mode needs — the patients +
 * measurements cards in the train-mode flow, the one predict-measurements
 * card in the predict flow — with the `TxrIntake` store actions bound
 * (remove, the four offer answers). The card surface reads the store's ONE
 * validation slot itself, so a re-validated file's facts flow back through
 * the store with no local parsing anywhere in this module.
 *
 * The one deliberate handoff: picking a file (or the template/example
 * downloads, which are the same provider surface) goes to the intake
 * screen that owns the parse → inspect → validate flow — screen C
 * (`filesPath()`) in the train-mode flow, screen N (`predictFilesPath()`)
 * in the predict flow (CONS-UI-RUN-12's change-files targets). This
 * module never re-implements the decode, never calls the file-validation
 * operations and never imports the decode library (TEST-RUN-14's pin).
 */
import type { CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { Dialog } from '@ziee/kit'
import { useStore } from 'zustand'
import type { FileTableKind } from '@/api-client/types'
import type { IntakeSnapshot } from '@/modules/txrintake'
import {
  TxrFileCard,
  TxrIntake,
  useTxrIntakeStore,
} from '@/modules/txrintake'
import type { LoadedFile } from '@/modules/txrintake'
import { filesPath, predictFilesPath } from '../routes'

/** The run mode the dialog serves (the intake snapshot's own type — the
 *  mode literals stay in the provider's type surface). */
export type TxrChangeFilesMode = IntakeSnapshot['mode']

/** The card's slot + kind pair (one card per mount). */
interface CardMount {
  kind: FileTableKind
  slot: 'patients' | 'measurements' | 'predictMeasurements'
}

/** The mode's cards: the two train files, or the one predict file. */
function cardsFor(mode: TxrChangeFilesMode): CardMount[] {
  if (mode === 'predict') {
    return [{ kind: 'measurements', slot: 'predictMeasurements' }]
  }
  return [
    { kind: 'patients', slot: 'patients' },
    { kind: 'measurements', slot: 'measurements' },
  ]
}

/** The dialog's scrollable body (the two cards stack like the C screen). */
const BODY: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
}

export interface TxrChangeFilesDialogProps {
  mode: TxrChangeFilesMode
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function TxrChangeFilesDialog({ mode, open, onOpenChange }: TxrChangeFilesDialogProps) {
  const navigate = useNavigate()
  // The three store slots, one top-level read each (the mapping below picks
  // the mode's cards — the hook order never depends on the mode).
  const patients = useStore(useTxrIntakeStore, s => s.patients)
  const measurements = useStore(useTxrIntakeStore, s => s.measurements)
  const predictMeasurements = useStore(useTxrIntakeStore, s => s.predictMeasurements)
  const files: Record<CardMount['slot'], LoadedFile | null> = {
    patients,
    measurements,
    predictMeasurements,
  }
  const cards = cardsFor(mode)

  /**
   * The pick / download handoff: the provider's screens own the file flow
   * (parse → inspect → validate), so every "give me a new file" affordance
   * of the card goes there. The dialog closes with the navigation.
   */
  const changeTarget = mode === 'predict' ? predictFilesPath() : filesPath()
  const handOff = () => navigate(changeTarget)

  return (
    <Dialog
      data-testid="txr-run-change-files-dialog"
      title="Change files"
      open={open}
      onOpenChange={onOpenChange}
      size="xl"
    >
      <div style={BODY}>
        {cards.map(card => (
          <TxrFileCard
            key={card.slot}
            kind={card.kind}
            mode={mode}
            file={files[card.slot]}
            busy={false}
            error={null}
            onPick={handOff}
            onRemove={() => TxrIntake.removeFile(card.slot)}
            onAcceptJoin={offer => TxrIntake.acceptJoin(offer)}
            onRejectJoin={offer => TxrIntake.rejectJoin(offer)}
            onAcceptVocab={offer => TxrIntake.acceptVocab(offer)}
            onRejectVocab={offer => TxrIntake.rejectVocab(offer)}
            onDownloadTemplate={handOff}
            onDownloadExample={handOff}
          />
        ))}
      </div>
    </Dialog>
  )
}
