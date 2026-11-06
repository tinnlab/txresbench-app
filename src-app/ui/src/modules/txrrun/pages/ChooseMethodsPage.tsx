import { useState } from 'react'
import type { CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from 'zustand'
import { useTxrIntakeStore } from '@/modules/txrintake'
import { buildSlotSummaries, runSetupMissing } from '../lib/slotSummary'
import { TxrChangeFilesDialog } from '../components/TxrChangeFilesDialog'
import { TxrRunEmptyState } from '../components/TxrRunEmptyState'
import { TxrSlotSummary } from '../components/TxrSlotSummary'

/**
 * Screen E — Choose the methods and settings (board `Busy.dc.html`): the
 * file-slot lines (Patients / Measurements / Predict with "Change files"),
 * the four setting rows (Predict, Decision day, Look ahead to, Extra
 * inputs + More settings), the shared method list with its group chips and
 * the bottom bar (selected count, total time, run-N-at-a-time, save-the-
 * trained-models, research notice, Run).
 *
 * ITEM-6 delivers the page BASE: the board's page chrome (from ITEM-1),
 * the slot summary (the data line + the change-files dialog, DEC-9/13) and
 * the not-configured state (DEC-16). The settings rows (ITEM-7), the
 * shared list + run creation (ITEM-8) extend this same file below the
 * slots; the page already reads the intake store (the ONE snapshot the
 * later screens read, PROV-UI-INTAKE-2) and navigates only through the
 * module's path builders (never a URL literal).
 *
 * The empty state's rule: the E content renders when the run's mode has
 * its inputs (the two train files, or the one predict file); anything
 * partial shows the state naming the missing piece. The slot lines render
 * the store's own facts (the file names + the ONE validated summary) —
 * this page never re-validates and never formats a number.
 */
const PAGE_OUTER: CSSProperties = {
  flexGrow: 1,
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
}

const PAGE_MAIN: CSSProperties = {
  flexGrow: 1,
  boxSizing: 'border-box',
  padding: '24px 36px',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  minWidth: 0,
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

export function ChooseMethodsPage() {
  const navigate = useNavigate()
  const [changeOpen, setChangeOpen] = useState(false)
  const mode = useStore(useTxrIntakeStore, s => s.mode)
  const patients = useStore(useTxrIntakeStore, s => s.patients)
  const measurements = useStore(useTxrIntakeStore, s => s.measurements)
  const predictMeasurements = useStore(useTxrIntakeStore, s => s.predictMeasurements)
  const validation = useStore(useTxrIntakeStore, s => s.validation)

  const missing = runSetupMissing({ mode, patients, measurements, predictMeasurements })
  if (missing !== null) {
    return (
      <main data-testid="txr-run" style={PAGE_OUTER}>
        <div style={PAGE_MAIN}>
          <div style={STEP_LINE}>Step 4 of 4</div>
          <h1 style={TITLE}>Choose the methods and settings</h1>
          <TxrRunEmptyState missing={missing} onStartNew={() => navigate('/')} />
        </div>
      </main>
    )
  }

  return (
    <main data-testid="txr-run" style={PAGE_OUTER}>
      <div style={PAGE_MAIN}>
        <div style={STEP_LINE}>Step 4 of 4</div>
        <h1 style={TITLE}>Choose the methods and settings</h1>
        <TxrSlotSummary
          slots={buildSlotSummaries({ mode, patients, measurements, predictMeasurements, validation })}
          onChangeFiles={() => setChangeOpen(true)}
        />
      </div>
      <TxrChangeFilesDialog
        mode={mode}
        open={changeOpen}
        onOpenChange={setChangeOpen}
      />
    </main>
  )
}
