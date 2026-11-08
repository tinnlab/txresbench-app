/**
 * TxrListSectionHeader — one screen-I run group header
 * (`Saved.dc.html`): the group's title, the run-facts subtitle, the
 * group select-all, and the host actions (Rename default, "Delete the
 * run's models" in the board's danger red).
 *
 * Board-exact facts of this layout (DEC-8/DEC-10):
 * - the header row is the board's flex line: checkbox, bold title,
 *   `13.5px #5e5e5e` subtitle (the run facts: "trained 19 Oct on
 *   patients.csv · 151 patients · 11 models · progression or death by
 *   day 238"), a spacer, then the action links;
 * - the select-all is CONTROLLED like every selection control in the
 *   module: its checked state is derived from the host's `selected` set
 *   over the section's own `rowKeys` (checked ⇔ every non-disabled
 *   rowKey is selected), and a change reports the SECTION back — the
 *   host applies `lib/selection.ts`'s `toggleSection`, so exactly the
 *   section's eligible rows move and the disabled ones never do
 *   (EXAMPLE-UL-4; the same semantics TEST-UL-2 pins on the helper);
 * - the actions are a slot: `onSectionAction(sectionKey, actionId)` —
 *   `model-store` owns rename/delete (DEC-10). The label + tone come
 *   from the host's `TxrListSection.actions`; the danger tone is the
 *   board's `#b3261e`, the default tone the board's link blue.
 */
import type { CSSProperties } from 'react'
import { Button, Checkbox } from '@ziee/kit'
import type { TxrListRow, TxrListSection } from '../types'

/** The section action link colours (board literals; DEC-8). */
const SECTION_ACTION_COLORS: Record<'default' | 'danger', string> = {
  default: '#1d4e89',
  danger: '#b3261e',
}

/** The board's action-link look (a text button, not navigation). */
const SECTION_ACTION_LINK: CSSProperties = { fontSize: 13 }

export interface TxrListSectionHeaderProps {
  /** The run group to render (title, run facts, rowKeys, actions). */
  section: TxrListSection
  /** The rows the list received — the rowKeys resolve against these. */
  rows: ReadonlyArray<TxrListRow>
  /** The host's selection set (the section's checked state derives from it). */
  selected: ReadonlySet<string>
  /** The section's select-all checkbox toggled (the host applies `toggleSection`). */
  onToggleSection?: (section: TxrListSection) => void
  /** A host action (Rename / delete-the-run's-models) was clicked. */
  onSectionAction?: (sectionKey: string, actionId: string) => void
}

export function TxrListSectionHeader({
  section,
  rows,
  selected,
  onToggleSection,
  onSectionAction,
}: TxrListSectionHeaderProps) {
  // The section's selectable keys: rowKeys that resolve to a non-disabled
  // row the list received (EXAMPLE-UL-4's 9 of 11). A stale key (a model
  // removed from the list) and the 2 disabled rows are never part of the
  // toggle and never make the box show checked.
  const selectableKeys = section.rowKeys.filter(key =>
    rows.some(row => row.key === key && !row.run.disabled),
  )
  const allSelected =
    selectableKeys.length > 0 && selectableKeys.every(key => selected.has(key))
  return (
    <div
      data-testid={`txr-list-section-${section.key}`}
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '10px 14px',
        padding: '8px 4px',
      }}
    >
      <Checkbox
        className="txr-list-checkbox"
        data-testid={`txr-list-section-select-all-${section.key}`}
        aria-label={`Select all of ${section.title}`}
        checked={allSelected}
        onCheckedChange={() => onToggleSection?.(section)}
      />
      <span style={{ fontWeight: 700 }}>{section.title}</span>
      <span style={{ fontSize: 13.5, color: '#5e5e5e' }}>{section.subtitle}</span>
      <span style={{ flexGrow: 1 }} />
      {section.actions.map(action => (
        <Button
          key={action.id}
          data-testid={`txr-list-section-action-${section.key}-${action.id}`}
          variant="link"
          style={{
            ...SECTION_ACTION_LINK,
            color: SECTION_ACTION_COLORS[action.tone],
            height: 'auto',
            padding: 0,
          }}
          onClick={() => onSectionAction?.(section.key, action.id)}
        >
          {action.label}
        </Button>
      ))}
    </div>
  )
}
