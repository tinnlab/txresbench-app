// Small pure presentation helpers for the datasets module.

import { datatypeRegistry } from '@/core/datatypes'

/** The human title for a datatype id (falls back to the raw id, or "Untyped"). */
export function datatypeLabel(datatype: string | undefined): string {
  if (!datatype) return 'Untyped'
  return datatypeRegistry.get(datatype)?.title ?? datatype
}

/** A short, copy-safe rendering of a `sha256:<hex>` content hash. */
export function shortHash(hash: string | undefined): string {
  if (!hash) return '—'
  const hex = hash.includes(':') ? hash.split(':')[1] : hash
  return hex.length > 12 ? `${hex.slice(0, 12)}…` : hex
}

/** Human byte size (1024-based). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** i
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`
}

/** A friendly relative-ish date (YYYY-MM-DD). */
export function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toISOString().slice(0, 10)
}
