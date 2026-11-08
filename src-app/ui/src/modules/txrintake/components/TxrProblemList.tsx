/**
 * TxrProblemList — one card's per-row problem lines (PROV-UI-INTAKE-5).
 *
 * The list renders the `FileProblem` set of one file card: one line per
 * problem, the FILE row number first when the problem is a data-row problem
 * (the board's "Row 14: …" lines — the row is the provider's 1-based fact
 * INCLUDING the header, per PROV-FV-2/3), severity-colored per DEC-14
 * (`#b3261e` error, `#8a5a00` warning).
 *
 * Two qa-fixes ITEM-6 render rules:
 * - the "Row N:" prefix belongs to DATA rows only. Column-level problems
 *   (a missing required column, "no recognizable header") sit ON the
 *   header row (row 1 for the usual header at the top) but are not about a
 *   row — the old prefix made them read "Row 1: required column `os_days`
 *   is missing" (F5b); the prefix renders for `row > 1` (a data row always
 *   follows the header, so a row-1 problem is never a data-row fact; the
 *   rare header after preamble rows keeps a prefix on its own row, and the
 *   A01 message already names the row).
 * - the provider's messages carry markdown backticks around column names
 *   (`` `ctDNA_mean_MTM_per_ml` ``) and the list renders plain text (F5e):
 *   the backticks are display markup, not content, and were shown verbatim.
 *
 * Every problem line ends with its code as a link to the matching entry on
 * the Help page (`/help#problem-<code>` through the txrhelp route builder):
 * the problems list is the entry the Help troubleshooting section was
 * written for. The code link is the only content the board lines gain; the
 * row-free message bytes stay the provider's.
 *
 * The testid carries the card kind and group (`txr-intake-file-problems-<kind>`
 * for the red box, `txr-intake-file-notes-<kind>` for the notes group, DEC-15
 * + ITEM-6 F5d), so one list serves the C patients card, the C measurements
 * card and the N measurements card without duplication — and the browser
 * specs keep an unambiguous hook when a card shows both groups.
 */
import { useState, type CSSProperties } from 'react'
import { Button } from '@ziee/kit'
import { Link } from 'react-router-dom'
import type { FileProblem, FileTableKind } from '@/api-client/types'
import { helpPath, problemAnchorOf } from '@/modules/txrhelp'

/** The board's boxed list (problem lines are the provider's messages). */
const PROBLEM_LIST: CSSProperties = { margin: '4px 0 0', paddingLeft: 18, fontSize: 13.5 }
const PROBLEM_ERROR: CSSProperties = { color: '#b3261e' }
const PROBLEM_WARNING: CSSProperties = { color: '#8a5a00' }
const SHOW_ALL_LINK: CSSProperties = {
  fontSize: 13,
  color: '#1d4e89',
  fontWeight: 600,
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  textDecoration: 'underline',
}

/** The maximum problem lines rendered before the "Show all" disclosure (F2). */
const PROBLEM_ROW_CLIP = 20

const PROBLEM_CODE_LINK: CSSProperties = {
  marginLeft: 6,
  fontFamily: "'Source Code Pro', monospace",
  fontSize: 12,
  fontWeight: 600,
  color: '#1d4e89',
  textDecoration: 'underline',
  textUnderlineOffset: 3,
  whiteSpace: 'nowrap',
}

export interface TxrProblemListProps {
  kind: FileTableKind
  problems: readonly FileProblem[]
  /**
   * Which list this is (qa-fixes ITEM-6, F5d): the red box's ERROR list
   * (`problems`) or the notes group's warnings (`notes`) — the testid stays
   * unambiguous for the browser specs (a card can render both groups).
   */
  group?: 'problems' | 'notes'
}

/** Strip the provider's markdown emphasis (`` `name` ``) — the list is plain text. */
function plainMessage(message: string): string {
  return message.replace(/`([^`]*)`/g, '$1')
}

/** One problem line: the file row when the problem is a DATA-row problem. */
function problemLine(problem: { row?: number | null; message: string }): string {
  const row = problem.row
  return row !== undefined && row !== null && row > 1
    ? `Row ${row}: ${plainMessage(problem.message)}`
    : plainMessage(problem.message)
}

export function TxrProblemList(props: TxrProblemListProps) {
  const { kind, problems, group = 'problems' } = props
  // qa-fixes ITEM-6, F2: the list is CLIPPED (the report's 39,673 px page was
  // one problem line per row over 630 rows). First 20, then the board's
  // "Show all N" disclosure (the J table's own pattern).
  const [expanded, setExpanded] = useState(false)
  const clipped = problems.length > PROBLEM_ROW_CLIP
  const visible = clipped && !expanded ? problems.slice(0, PROBLEM_ROW_CLIP) : problems
  return (
    <ul style={PROBLEM_LIST} data-testid={`txr-intake-file-${group}-${kind}`}>
      {visible.map((problem, index) => (
        <li
          key={`${problem.code}-${index}`}
          style={problem.severity === 'error' ? PROBLEM_ERROR : PROBLEM_WARNING}
        >
          {problemLine(problem)}
          <Link
            to={helpPath(problemAnchorOf(problem.code))}
            data-testid={`txr-intake-problem-help-${problem.code}`}
            aria-label={`Help for problem code ${problem.code}`}
            style={PROBLEM_CODE_LINK}
          >
            {problem.code}
          </Link>
        </li>
      ))}
      {clipped ? (
        <li>
          <Button
            variant="link"
            data-testid={`txr-intake-file-${group}-show-all-${kind}`}
            style={SHOW_ALL_LINK}
            onClick={() => setExpanded(expanded => !expanded)}
          >
            {expanded ? 'Show fewer' : `Show all ${problems.length} ${group}`}
          </Button>
        </li>
      ) : null}
    </ul>
  )
}
