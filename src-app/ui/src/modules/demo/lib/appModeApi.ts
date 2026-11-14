import { ApiClient } from '@/api-client'
import type { AppModeResponse } from '@/api-client/types'

/**
 * The ONE network read of the demo-mode UI foundation (ITEM-5): the public
 * `GET /api/app/mode`, through the generated client. Standing alone so the
 * store's retry ladder can be unit-tested against a mocked module instead of
 * faking the transport.
 */
export function fetchAppMode(): Promise<AppModeResponse> {
  return ApiClient.App.mode(undefined, undefined)
}
