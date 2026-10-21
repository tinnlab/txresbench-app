// FE-local job-frame types + the pure SSE-frame mapper (ITEM-22). The workbench run
// surface needs richer per-frame data than the published `jobs` contract's `JobFrame`
// (`{ phase, pct?, message? }`) carries — the live log console reads log lines, the
// resource line reads metric samples — but the contract `streamJob(onFrame: (f:
// JobFrame) => void)` must not change.
//
// So `WorkbenchJobFrame` EXTENDS `JobFrame` (a structural superset): it is still a
// valid `JobFrame`, so it flows through the existing callback unchanged, and the run
// pane reads the extra `kind`/`metric`/`log` fields via a cast. The `metric.value`
// bug this replaces read a field the backend NEVER emits: the jobs SSE `metric`
// event is a `JobMetric { cpu_pct, mem_bytes, … }` (there is no `value`), the `log`
// event is a `JobLog { content, stream, seq }` (not `data.message`), and the
// `progress` event (`ProgressFrame { phase, pct, message }`) — the REAL progress
// driver — was dropped entirely. See `server/src/modules/jobs/sse.rs`.

import type { JobFrame } from './contract.ts'

/** The four jobs-SSE event families (`server/src/modules/jobs/sse.rs::SSEJobEvent`). */
export type JobFrameKind = 'status' | 'progress' | 'metric' | 'log'

/** A resource sample carried on a frame (the jobs SSE `metric` event = `JobMetric`). */
export interface FrameMetric {
  cpuPct: number
  memBytes: number
  memPeakBytes?: number | null
  pidsCurrent?: number | null
}

/** A captured log line carried on a frame (the jobs SSE `log` event = `JobLog`). */
export interface FrameLog {
  seq: number
  stream: string
  content: string
}

/**
 * FE-LOCAL richer job frame (ITEM-22). A `JobFrame` (`phase`/`pct`/`message`, the
 * lifecycle view the shared run logic keys on) PLUS the typed `metric`/`log` payloads
 * the run console reads. It is assignable to `JobFrame`, so `streamJob`'s
 * `(f: JobFrame) => void` callback carries it unchanged; the run pane recovers the
 * extra fields with `f as WorkbenchJobFrame`.
 */
export interface WorkbenchJobFrame extends JobFrame {
  kind: JobFrameKind
  metric?: FrameMetric
  log?: FrameLog
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * Map ONE raw jobs-SSE event → a FE frame (ITEM-22). Pure — the unit test drives it
 * directly. Returns `null` for the framework `__init` control event and any unknown
 * event name (so an unrecognized frame is dropped, never mis-mapped).
 *
 * - `status`  → `{ phase: status }`         — the terminal-lifecycle signal.
 * - `progress`→ `{ phase, pct, message }`   — the REAL progress driver (was dropped).
 * - `metric`  → reads `cpu_pct`/`mem_bytes` — NOT the non-existent `data.value`.
 * - `log`     → reads `content`/`stream`    — NOT the non-existent `data.message`.
 */
export function mapSseFrame(event: string, data: unknown): WorkbenchJobFrame | null {
  const d = (data ?? {}) as Record<string, unknown>
  switch (event) {
    case 'status':
      return { kind: 'status', phase: typeof d.status === 'string' ? d.status : '' }
    case 'progress':
      return {
        kind: 'progress',
        phase: typeof d.phase === 'string' ? d.phase : 'progress',
        pct: num(d.pct),
        message: typeof d.message === 'string' ? d.message : undefined,
      }
    case 'metric':
      return {
        kind: 'metric',
        phase: 'metric',
        metric: {
          cpuPct: num(d.cpu_pct) ?? 0,
          memBytes: num(d.mem_bytes) ?? 0,
          memPeakBytes: num(d.mem_peak_bytes) ?? null,
          pidsCurrent: num(d.pids_current) ?? null,
        },
      }
    case 'log':
      return {
        kind: 'log',
        phase: 'log',
        message: typeof d.content === 'string' ? d.content : undefined,
        log: {
          seq: num(d.seq) ?? 0,
          stream: typeof d.stream === 'string' ? d.stream : 'stdout',
          content: typeof d.content === 'string' ? d.content : '',
        },
      }
    default:
      return null
  }
}
