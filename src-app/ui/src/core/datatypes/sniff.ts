// FE sniff helper (ITEM-13): POST a file to `/api/datatypes/sniff` and get the
// detected datatype, so an upload picker can pre-fill the type (the user never
// types a raw datatype id). Rides the generated `ApiClient` (multipart FormData).

import { ApiClient } from '@/api-client'

export interface SniffResult {
  datatype: string | null
  filename: string
}

/** Detect the datatype of a file (by extension + magic bytes) via the backend. */
export async function sniffFile(file: File): Promise<SniffResult> {
  const fd = new FormData()
  fd.append('file', file)
  return (await ApiClient.Datatype.sniff(fd)) as unknown as SniffResult
}
