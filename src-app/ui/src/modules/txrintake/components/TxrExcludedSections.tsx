/**
 * txrintake screen B — the grouped left-out list (step2-filters, brief 5b).
 *
 * The excluded methods are grouped by their FIRST reason's code into ONE
 * collapsible section per code, in this order: disease, treatment, outcome,
 * then every other reason code together. Sections are collapsed by default;
 * opening one shows the current one-line-per-method rows for it (the same
 * row text as before — id + the one reason line), and a section longer than
 * the board clip keeps the "Show all N / Show fewer" affordance INSIDE it.
 *
 * The overall heading and the fit / left-out totals live at the page; this
 * component is the list's grouping + expansion only. Open/closed is VIEW
 * state (never an answer), so there is deliberately no registered action —
 * nothing a human can trigger here mutates the store.
 */
import { useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger } from '@txresbench/kit'
import type { CSSProperties } from 'react'
import { groupExcludedMethods, type ExcludedGroupCode, type ExcludedMethod } from '../lib/preview'
import { excludedSectionHeading } from '../lib/format'

/** One row's id column (monospace, the board's id byte). */
const EXCLUDED_ID: CSSProperties = {
  fontFamily: "'Source Code Pro', monospace",
  fontSize: 12.5,
  minWidth: 210,
  // qa-fixes ITEM-6 S2: `wordBreak: 'break-all'` broke ids MID-WORD at the
  // hyphens' worst place ("ca125-confirmed-50pct-res / ponse").
  // `overflowWrap: 'anywhere'` (with the break rule back to normal) prefers
  // the hyphen break points and only breaks anywhere when a single word is
  // longer than the column — the ids stay whole.
  wordBreak: 'normal',
  overflowWrap: 'anywhere',
}

const EXCLUDED_REASON: CSSProperties = { color: 'var(--txr-muted)', fontSize: 13.5 }

const EXCLUDED_UL: CSSProperties = { margin: 0, padding: 0, listStyle: 'none' }

const EXCLUDED_LI: CSSProperties = {
  display: 'flex',
  gap: 10,
  padding: '5px 0',
  borderBottom: '1px solid var(--txr-surface-raised)',
}

/** The section heading trigger — a plain-word disclosure, not a kit Button
 *  (it is local view state, never a store mutation). Base UI's trigger
 *  renders an unstyled native button, so the page's own token styling is
 *  supplied here (the page's inline-style idiom). The chevron (study-step-
 *  ui-tweaks) leads the heading; it turns down when the section opens. */
const SECTION_TRIGGER: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  width: '100%',
  padding: '6px 0 2px',
  background: 'none',
  border: 'none',
  textAlign: 'left',
  font: 'inherit',
  fontSize: 13.5,
  fontWeight: 600,
  color: 'var(--txr-brand)',
  cursor: 'pointer',
}

/** The heading's disclosure chevron (the study-step-ui-tweaks direction
 *  marker: `data-state` follows the trigger's `aria-expanded`). */
const CHEVRON: CSSProperties = { transition: 'transform 150ms', flexShrink: 0 }

/** The "Show all N" link inside a long section (the same flush-link bytes
 *  the old single list's Show all carried — qa-fixes ITEM-6 S4). */
const LINK: CSSProperties = {
  padding: 0,
  fontSize: 13.5,
  color: 'var(--txr-brand)',
  fontWeight: 600,
}

/** One section's stable short key — the suffix its test ids carry
 *  (`txr-intake-excluded-section-<key>`, `txr-intake-excluded-show-all-<key>`):
 *  the bucket's readable name, never the raw reason code. The review (brief
 *  5b2 ITEM-1) found the component rendering `DISEASE_NOT_MATCHED…` while the
 *  tests opened `disease|treatment|outcome` — one section reachable by two
 *  names, and every trigger unreachable by the name the tests opened it
 *  with. The key is a pure presentation naming; grouping/order still key on
 *  the reason code. */
export function excludedSectionKey(code: ExcludedGroupCode): string {
  switch (code) {
    case 'DISEASE_NOT_MATCHED':
      return 'disease'
    case 'TREATMENT_NOT_MATCHED':
      return 'treatment'
    case 'OUTCOME_NOT_MATCHED':
      return 'outcome'
    case 'MARKER_COUNT_UNMET':
      return 'marker-count'
    default:
      return 'other'
  }
}

export interface TxrExcludedSectionsProps {
  /** The excluded rows (one reason line per method, list order). */
  excluded: ExcludedMethod[]
  /** The maximum directly-visible rows of one OPEN section. */
  limit: number
}

export function TxrExcludedSections({ excluded, limit }: TxrExcludedSectionsProps) {
  const groups = useMemo(() => groupExcludedMethods(excluded), [excluded])
  // Collapsed by default; open/closed is view state only (never stored).
  const [open, setOpen] = useState<Partial<Record<ExcludedGroupCode, boolean>>>({})
  // "Show all N" per section: an opened section longer than the clip keeps
  // its own expand state, so one section's expand never leaks into another.
  const [expanded, setExpanded] = useState<Partial<Record<ExcludedGroupCode, boolean>>>({})

  return (
    // study-step-ui-tweaks: the group list sits ~16 px in, so the headings
    // read as parts of the "N methods are left out" heading above them; the
    // method rows inside a group stay indented with their heading.
    <div data-testid="txr-intake-excluded-groups" style={{ paddingLeft: 16 }}>
      {groups.map(group => {
        const isOpen = open[group.code] === true
        const showAll = expanded[group.code] === true
        const visible = showAll ? group.methods : group.methods.slice(0, limit)
        const hasMore = group.methods.length > limit
        const key = excludedSectionKey(group.code)
        return (
          <Collapsible
            key={group.code}
            open={isOpen}
            onOpenChange={next => setOpen(prev => ({ ...prev, [group.code]: next }))}
          >
            <CollapsibleTrigger
              data-testid={`txr-intake-excluded-section-${key}`}
              style={SECTION_TRIGGER}
            >
              <ChevronRight
                aria-hidden
                size={14}
                data-state={isOpen ? 'open' : 'closed'}
                style={{
                  ...CHEVRON,
                  transform: isOpen ? 'rotate(90deg)' : undefined,
                }}
              />
              {excludedSectionHeading(group.code, group.methods.length)}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul style={EXCLUDED_UL}>
                {visible.map(method => (
                  <li key={method.id} style={EXCLUDED_LI} className="txr-intake-excluded-row">
                    <span style={EXCLUDED_ID}>{method.id}</span>
                    <span style={EXCLUDED_REASON}>{method.reasonText}</span>
                  </li>
                ))}
              </ul>
              {hasMore ? (
                <Button
                  data-testid={`txr-intake-excluded-show-all-${key}`}
                  variant="link"
                  style={LINK}
                  onClick={() =>
                    setExpanded(prev => ({ ...prev, [group.code]: !(prev[group.code] ?? false) }))
                  }
                >
                  {showAll ? 'Show fewer' : `Show all ${group.methods.length}`}
                </Button>
              ) : null}
            </CollapsibleContent>
          </Collapsible>
        )
      })}
    </div>
  )
}
