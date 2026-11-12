/**
 * TxrProblemList — one card's per-row problem lines (PROV-UI-INTAKE-5).
 *
 * The list renders the `FileProblem` set of one file card: one line per
 * problem group, severity-colored per DEC-14 (`var(--txr-danger)` error,
 * `var(--txr-warning)` warning).
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
 * qa-fixes2 ITEM-5 render rules (R2-5, R2-3):
 * - the lines are GROUPED by the plain message (R2-5): the old list was a
 *   wall of identical lines — "Row 2: empty cell in a required (not-null)
 *   column" ×3 per row ×20 rows — and the clip only postponed it. One
 *   group = one line: a contiguous run of rows reads with the board's own
 *   "Rows 88 to 91: …" bytes, a single row keeps the "Row 14: …" byte,
 *   and anything else reads "«message» — N rows" (the report's own
 *   "…: 1890 rows" suggestion).
 * - the internal rule codes are OUT of the user's line (R2-3: codes like
 *   "R02", "A04" are clinician jargon, the old renderer had them as bold
 *   underlined links glued to the sentence). The codes stay one "details"
 *   disclosure below the list — "Show the problem codes" — where each code
 *   links to its Help entry (`/help#problem-<code>` through the txrhelp
 *   route builder), so the diagnostic surface is still one click away and
 *   the plain sentence reads clean.
 *
 * The testid carries the card kind and group (`txr-intake-file-problems-<kind>`
 * for the red box, `txr-intake-file-notes-<kind>` for the notes group, DEC-15
 * + ITEM-6 F5d), so one list serves the C patients card, the C measurements
 * card and the N measurements card without duplication — and the browser
 * specs keep an unambiguous hook when a card shows both groups.
 */
import { useState, type CSSProperties } from 'react'
import { Button } from '@txresbench/kit'
import { Link } from 'react-router-dom'
import type { FileProblem, FileTableKind } from '@/api-client/types'
import { helpPath, problemAnchorOf } from '@/modules/txrhelp'
import { pluralize } from '../lib/format'

/** The board's boxed list (problem lines are the provider's messages). */
const PROBLEM_LIST: CSSProperties = { margin: '4px 0 0', paddingLeft: 18, fontSize: 13.5 }
const PROBLEM_ERROR: CSSProperties = { color: 'var(--txr-danger)' }
const PROBLEM_WARNING: CSSProperties = { color: 'var(--txr-warning)' }
const SHOW_ALL_LINK: CSSProperties = {
  fontSize: 13,
  color: 'var(--txr-brand)',
  fontWeight: 600,
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  textDecoration: 'underline',
}

/** The maximum problem lines rendered before the "Show all" disclosure (F2;
 *  R2-5: the lines are GROUPS, not per-row duplicates). */
const PROBLEM_ROW_CLIP = 20

/** The disclosure's framed row (codes are diagnostic chrome, not a sentence). */
const CODES_DETAILS: CSSProperties = { marginTop: 6, fontSize: 12.5, color: 'var(--txr-muted)' }
const CODES_SUMMARY: CSSProperties = {
  cursor: 'pointer',
  color: 'var(--txr-muted)',
  fontWeight: 600,
}
const CODES_LIST: CSSProperties = { margin: '4px 0 0', paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 2 }
const CODES_CODE: CSSProperties = {
  fontFamily: "'Source Code Pro', monospace",
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--txr-brand)',
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

/**
 * One grouped line: the problems sharing one plain message, in first-
 * occurrence order (R2-5). A contiguous run of data rows reads with the
 * board's "Rows 88 to 91: …" byte; a single row keeps "Row 14: …" (when the
 * row is a data row); a scattered set reads "«message» — N rows" (the
 * report's own suggestion — row numbers are meaningless across 1,890 rows).
 */
export interface ProblemGroup {
  message: string
  problems: FileProblem[]
}

/** The grouped view of a problem set (the pure seam the lines render). */
export function groupProblems(problems: readonly FileProblem[]): ProblemGroup[] {
  const byMessage = new Map<string, ProblemGroup>()
  const ordered: ProblemGroup[] = []
  for (const problem of problems) {
    const message = plainMessage(problem.message)
    let group = byMessage.get(message)
    if (group === undefined) {
      group = { message, problems: [] }
      byMessage.set(message, group)
      ordered.push(group)
    }
    group.problems.push(problem)
  }
  return ordered
}

/** The row numbers of a group, when EVERY problem is a data-row problem. */
function dataRows(group: ProblemGroup): number[] | null {
  const rows = group.problems.map(p => p.row).filter(r => r !== undefined && r !== null && r > 1)
  if (rows.length !== group.problems.length) return null
  return rows as number[]
}

/** The group's one line (the board's row-run / single-row / count bytes). */
function groupLine(group: ProblemGroup): string {
  const rows = dataRows(group)
  if (rows !== null && rows.length > 1) {
    const run = rows.every((row, i) => i === 0 || row === rows[i - 1] + 1)
    if (run) return `Rows ${rows[0]} to ${rows[rows.length - 1]}: ${group.message}`
  }
  if (group.problems.length === 1) return problemLine(group.problems[0])
  return `${group.message} — ${pluralize(group.problems.length, 'row')}`
}

/** The distinct codes of one group (a "same message" group can carry both
 *  severities of one dual code — A04 — or, in theory, two codes that share
 *  their wording; every code keeps its own Help link here). */
function groupCodes(group: ProblemGroup): FileProblem['code'][] {
  return [...new Set(group.problems.map(p => p.code))].sort()
}

/** The disclosure inside the list: one code link per group, with the
 *  message it belongs to (R2-3 — the code is out of the sentence but still
 *  one click from its Help entry). */
function CodesDisclosure({ kind, group, groups }: { kind: FileTableKind; group: 'problems' | 'notes'; groups: ProblemGroup[] }) {
  return (
    <details style={CODES_DETAILS} data-testid={`txr-intake-file-${group}-codes-${kind}`}>
      <summary style={CODES_SUMMARY}>Show the problem codes</summary>
      <ul style={CODES_LIST}>
        {groups.map(one => (
          <li key={one.message} style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <span>
              {groupCodes(one).map(code => (
                <Link
                  key={code}
                  to={helpPath(problemAnchorOf(code))}
                  data-testid={`txr-intake-problem-help-${code}`}
                  aria-label={`Help for problem code ${code}`}
                  style={CODES_CODE}
                >
                  {code}
                </Link>
              ))}
            </span>
            <span>
              {one.message}
              {one.problems.length > 1 ? ` — ${pluralize(one.problems.length, 'row')}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </details>
  )
}

export function TxrProblemList(props: TxrProblemListProps) {
  const { kind, problems, group = 'problems' } = props
  // R2-5: the clip counts GROUPS (one line per message), not rows — the
  // report's wall of identical rows is one line per message now.
  const [expanded, setExpanded] = useState(false)
  const groups = groupProblems(problems)
  const clipped = groups.length > PROBLEM_ROW_CLIP
  const visible = clipped && !expanded ? groups.slice(0, PROBLEM_ROW_CLIP) : groups
  return (
    <ul style={PROBLEM_LIST} data-testid={`txr-intake-file-${group}-${kind}`}>
      {visible.map(one => (
        <li
          key={one.message}
          style={one.problems[0].severity === 'error' ? PROBLEM_ERROR : PROBLEM_WARNING}
        >
          {groupLine(one)}
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
            {expanded ? 'Show fewer' : `Show all ${groups.length} ${group}`}
          </Button>
        </li>
      ) : null}
      <li>
        <CodesDisclosure kind={kind} group={group} groups={groups} />
      </li>
    </ul>
  )
}
