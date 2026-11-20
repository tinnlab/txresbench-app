/**
 * Check the files again after the last-draw day changed.
 *
 * The last-draw day is the file check's decision day: a new day forgets the
 * check (`patchParameters` nulls `validation`), and the method step never
 * checks the files itself. The study step comes after the files step, so it
 * runs the same validate call again (the files, the confirmed joins and
 * mappings, the new day) and stores the answer the usual way
 * (`applyValidation`, guarded against a change while it was in flight). The
 * offers were settled on the files step and are not touched here, and no
 * problem of the file check depends on the day, so the new answer cannot add
 * a blocking problem.
 *
 * Nothing runs while the files are not all there, not yet inspected (the
 * files step still owns them), or while a check is already valid.
 */
import { useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { ApiClient } from '@/api-client'
import { useTxrIntakeStore } from '../stores/TxrIntake.store'
import type { IntakeValidationKey } from '../stores/TxrIntake.store'
import { validateRequest } from '../lib/flow'

export interface Recheck {
  /** A check of the files is running (the day changed). */
  checking: boolean
  /** The last check failed (plain words), or null. */
  error: string | null
  /** Whether a check is owed at THIS moment (running, or about to run).
   *  Read at call time (a store + ref read), never from a render closure, so
   *  a click that races a just-started re-check sees the truth. */
  pending: () => boolean
}

function errorText(err: unknown): string {
  if (err instanceof Error && err.message.length > 0) return err.message
  return 'The files could not be checked again.'
}

/** The files of the current mode are all there and inspected. */
function filesReady(): boolean {
  const s = useTxrIntakeStore.getState()
  if (s.mode === 'predict') return s.predictMeasurements?.inspection != null
  return s.patients?.inspection != null && s.measurements?.inspection != null
}

/** Whether the current state still owes a check (running or about to run). */
function checkOwed(): boolean {
  const s = useTxrIntakeStore.getState()
  return s.validation === null && filesReady()
}

/** The validation key a failed check ran for, and whether it is the current
 *  one (the store's own order-sensitive equality, same shape). */
function sameKey(a: IntakeValidationKey, b: IntakeValidationKey): boolean {
  return (
    JSON.stringify(a.joins) === JSON.stringify(b.joins) &&
    JSON.stringify(a.mapping) === JSON.stringify(b.mapping) &&
    JSON.stringify(a.parameters) === JSON.stringify(b.parameters)
  )
}

export function useRecheck(): Recheck {
  const validation = useStore(useTxrIntakeStore, s => s.validation)
  const parameters = useStore(useTxrIntakeStore, s => s.parameters)
  const joins = useStore(useTxrIntakeStore, s => s.joins)
  const mapping = useStore(useTxrIntakeStore, s => s.mapping)
  const patients = useStore(useTxrIntakeStore, s => s.patients)
  const measurements = useStore(useTxrIntakeStore, s => s.measurements)
  const predictMeasurements = useStore(useTxrIntakeStore, s => s.predictMeasurements)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const busy = useRef(false)
  const rerun = useRef(false)
  const alive = useRef(true)
  const failed = useRef(false)
  // Which check failed: the validation key it ran for. A NEW key (a new day,
  // new files) means a fresh check is owed, so the old failure is not current
  // any more (a click before the fresh check's effect runs must still wait).
  const failedKey = useRef<IntakeValidationKey | null>(null)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    if (validation !== null || !filesReady()) return
    if (busy.current) {
      rerun.current = true
      return
    }
    busy.current = true
    failed.current = false
    failedKey.current = null
    setChecking(true)
    const state = useTxrIntakeStore.getState()
    const key = state.currentValidationKey()
    void ApiClient.FileValidation.validate(validateRequest(state.mode, state))
      .then(response => {
        useTxrIntakeStore.getState().applyValidation(response, key)
        if (alive.current) setError(null)
      })
      .catch(err => {
        if (alive.current) {
          failed.current = true
          failedKey.current = key
          setError(errorText(err))
        }
      })
      .finally(() => {
        busy.current = false
        if (!alive.current) return
        setChecking(false)
        if (rerun.current) {
          rerun.current = false
          setTick(t => t + 1)
        }
      })
  }, [validation, parameters, joins, mapping, patients, measurements, predictMeasurements, tick])

  return {
    checking: checking || (validation === null && filesReady() && error === null),
    error,
    pending: () => {
      if (!checkOwed()) return false
      if (!failed.current) return true
      const failedAt = failedKey.current
      if (failedAt === null) return false
      return !sameKey(useTxrIntakeStore.getState().currentValidationKey(), failedAt)
    },
  }
}
