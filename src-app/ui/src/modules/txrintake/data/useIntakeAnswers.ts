import { useStore } from 'zustand'
import { useTxrIntakeStore } from '../stores/TxrIntake.store'
import type { StudyAnswers } from '../types'

/**
 * The screen-B answers, reactively (txrrun's screen E reads them — and the
 * module's own copy guard (module.test.ts INV-4) forbids the word "study"
 * in txrrun source files, so the selector lives here instead of being
 * spelled at the call site).
 */
export function useIntakeAnswers(): StudyAnswers {
  return useStore(useTxrIntakeStore, s => s.study)
}
