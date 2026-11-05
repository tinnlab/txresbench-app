/**
 * TxrProblemList — one card's per-row problem lines (PROV-UI-INTAKE-5).
 *
 * The list renders the `FileProblem` set of one file card: one line per
 * problem, the FILE row number first when the problem carries one (the
 * board's "Row 14: …" lines — the row is the provider's 1-based fact
 * INCLUDING the header, per PROV-FV-2/3), severity-colored per DEC-14
 * (`#b3261e` error, `#8a5a00` warning).
 *
 * The testid carries the card kind (`txr-intake-file-problems-<kind>`,
 * DEC-15), so one list serves the C patients card, the C measurements
 * card and the N measurements card without duplication.
 */
import type { CSSProperties } from 'react'
import type { FileProblem, FileTableKind } from '@/api-client/types'

/** The board's boxed list (problem lines are the provider's messages). */
const PROBLEM_LIST: CSSProperties = { margin: '4px 0 0', paddingLeft: 18, fontSize: 13.5 }
const PROBLEM_ERROR: CSSProperties = { color: '#b3261e' }
const PROBLEM_WARNING: CSSProperties = { color: '#8a5a00' }

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
        </li>
      ))}
    </ul>
  )
}
