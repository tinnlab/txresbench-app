/**
 * Check the files again after the last-draw day changed.
 *
 * The last-draw day is the file check's decision day: a new day forgets the
 * check (`patchParameters` nulls `validation`), and the method step never
 * checks the files itself. The study step and step 4 come after the files
 * step, so they run the same validate call again (the files, the confirmed
 * joins and mappings, the new day) and store the answer the usual way
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
import { validateRequest } from '../lib/flow'

export interface Recheck {
  /** A check of the files is running (the day changed). */
  checking: boolean
  /** The last check failed (plain words), or null. */
  error: string | null
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

export function useRecheck(): Recheck {
  const validation = useStore(useTxrIntakeStore, s => s.validation)
  const parameters = useStore(useTxrIntakeStore, s => s.parameters)
  const patients = useStore(useTxrIntakeStore, s => s.patients)
  const measurements = useStore(useTxrIntakeStore, s => s.measurements)
  const predictMeasurements = useStore(useTxrIntakeStore, s => s.predictMeasurements)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const busy = useRef(false)
  const rerun = useRef(false)
  const alive = useRef(true)

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
    setChecking(true)
    const state = useTxrIntakeStore.getState()
    const key = state.currentValidationKey()
    void ApiClient.FileValidation.validate(validateRequest(state.mode, state))
      .then(response => {
        useTxrIntakeStore.getState().applyValidation(response, key)
        if (alive.current) setError(null)
      })
      .catch(err => {
        if (alive.current) setError(errorText(err))
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
  }, [validation, parameters, patients, measurements, predictMeasurements, tick])

  return { checking: checking || (validation === null && filesReady() && error === null), error }
}
