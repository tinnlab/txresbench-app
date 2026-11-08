/**
 * TxrProblemList — one card's per-row problem lines (PROV-UI-INTAKE-5).
 *
 * The list renders the `FileProblem` set of one file card: one line per
 * problem, the FILE row number first when the problem carries one (the
 * board's "Row 14: …" lines — the row is the provider's 1-based fact
 * INCLUDING the header, per PROV-FV-2/3), severity-colored per DEC-14
 * (`#b3261e` error, `#8a5a00` warning).
 *
 * Every problem line ends with its code as a link to the matching entry on
 * the Help page (`/help#problem-<code>` through the txrhelp route builder):
 * the problems list is the entry the Help troubleshooting section was
 * written for. The code link is the only content the board lines gain; the
 * row-free message bytes stay the provider's.
 *
 * The testid carries the card kind (`txr-intake-file-problems-<kind>`,
 * DEC-15), so one list serves the C patients card, the C measurements
 * card and the N measurements card without duplication.
 */
import type { CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import type { FileProblem, FileTableKind } from '@/api-client/types'
import { helpPath, problemAnchorOf } from '@/modules/txrhelp'

/** The board's boxed list (problem lines are the provider's messages). */
const PROBLEM_LIST: CSSProperties = { margin: '4px 0 0', paddingLeft: 18, fontSize: 13.5 }
const PROBLEM_ERROR: CSSProperties = { color: '#b3261e' }
const PROBLEM_WARNING: CSSProperties = { color: '#8a5a00' }
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
}

/** One problem line: the file row when the problem has one (board box). */
function problemLine(problem: { row?: number | null; message: string }): string {
  return problem.row !== undefined && problem.row !== null
    ? `Row ${problem.row}: ${problem.message}`
    : problem.message
}

export function TxrProblemList(props: TxrProblemListProps) {
  const { kind, problems } = props
  return (
    <ul style={PROBLEM_LIST} data-testid={`txr-intake-file-problems-${kind}`}>
      {problems.map((problem, index) => (
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
    </ul>
  )
}
