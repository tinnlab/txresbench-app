/**
 * TxrFileDrop — one card's drop zone (PROV-UI-INTAKE-5).
 *
 * The board's dashed drop zone, backed by the kit `Upload` — the ONE file
 * input of the surface (the native-controls lint's requirement: no raw
 * `<input>` outside the kit), accepting `.csv,.xlsx,.xls` (the plan's glove;
 * a legacy `.xls` byte reaches the provider, whose
 * `unsupported_file_type` / `legacy_xls` message is the authority — the
 * read-side tolerance never silently rejects a pick). The board copy is
 * derived from the card kind ("Drop the patients file here" /
 * "Drop the measurements file here" — identical on the C and N screens).
 *
 * `busy` disables the zone (a drop's parse/inspect is in flight); the
 * picked File is handed to `onPick` — the host owns decode + store.
 */
import type { CSSProperties } from 'react'
import { Upload } from '@ziee/kit'
import type { FileTableKind } from '@/api-client/types'

/** The zone (board bytes; the red dashed border is the design's emphasis). */
const DROPZONE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 16,
  padding: '14px 16px',
  border: '2px dashed var(--txr-danger)',
  borderRadius: 10,
  background: 'var(--txr-bg)',
  width: '100%',
  boxSizing: 'border-box',
  textAlign: 'left',
}
const DROPZONE_TEXT: CSSProperties = { display: 'block', flex: '1 1 auto', minWidth: 0 }
const DROPZONE_TITLE: CSSProperties = { display: 'block', fontWeight: 600 }
const DROPZONE_HINT: CSSProperties = { display: 'block', fontSize: 13, color: 'var(--txr-muted)' }
const DROPZONE_CHOOSE: CSSProperties = {
  padding: '6px 12px',
  border: '1px solid var(--txr-brand)',
  borderRadius: 6,
  color: 'var(--txr-brand)',
  fontWeight: 600,
  fontSize: 14,
  background: 'var(--txr-surface)',
  whiteSpace: 'nowrap',
}

/** The accepted spreadsheet glove (the kit Upload's `accept` attribute). */
export const TXR_FILE_ACCEPT = '.csv,.xlsx,.xls'

export interface TxrFileDropProps {
  kind: FileTableKind
  busy: boolean
  onPick: (file: File) => void
}

/** The zone's board title — "Drop the <kind> file here" (Files/PredictFiles). */
export function dropZoneLabel(kind: FileTableKind): string {
  return `Drop the ${kind} file here`
}

export function TxrFileDrop(props: TxrFileDropProps) {
  const { kind, busy, onPick } = props
  const label = dropZoneLabel(kind)
  return (
    <Upload
      data-testid={`txr-intake-file-drop-${kind}`}
      label={label}
      accept={TXR_FILE_ACCEPT}
      disabled={busy}
      // ITEM-6 F11: the kit's own dashed border would draw a second (pale)
      // dashed box around the board's red-dashed zone — the board has ONE
      // drop border, ours; the kit box is cleared.
      className="border-none"
      onFiles={picked => {
        const pick = picked[0]
        if (pick) onPick(pick)
      }}
    >
      <div style={DROPZONE}>
        <span style={{ color: 'var(--txr-brand)', fontWeight: 600, fontSize: 22 }} aria-hidden>
          ↓
        </span>
        <span style={DROPZONE_TEXT}>
          <span style={DROPZONE_TITLE}>{label}</span>
          <span style={DROPZONE_HINT}>
            CSV or Excel. The columns can be in any order; matching names are found for you.
          </span>
        </span>
        <span style={DROPZONE_CHOOSE}>Choose file</span>
      </div>
    </Upload>
  )
}
