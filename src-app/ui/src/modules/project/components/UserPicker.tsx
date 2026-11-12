import { ApiClient } from '@/api-client'
import { type AdminUserOption } from '@/api-client/types'
import { Input, Spinner, Tag } from '@txresbench/kit'
import { X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

interface UserPickerProps {
  value: AdminUserOption | null
  onChange: (user: AdminUserOption | null) => void
  /** User ids to hide from results (e.g. the current owner). */
  excludeIds?: string[]
  placeholder?: string
  testid: string
}

/**
 * Searchable single-select of users (username + email), backed by the scoped
 * admin `ProjectAdmin.searchUsers` endpoint (server-side ILIKE — DEC-6). Input
 * economy: pick a user, never type a UUID.
 */
export function UserPicker({ value, onChange, excludeIds, placeholder, testid }: UserPickerProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<AdminUserOption[]>([])
  const [loading, setLoading] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const seqRef = useRef(0)
  const excluded = useMemo(() => new Set(excludeIds ?? []), [excludeIds])

  useEffect(() => {
    if (value) return // a selection is shown instead of the list
    setLoading(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      // Sequence guard: only the latest in-flight search may set results, so
      // out-of-order responses can't show stale matches.
      const seq = ++seqRef.current
      void ApiClient.ProjectAdmin.searchUsers({ ...(query.trim() ? { search: query.trim() } : {}) })
        .then(res => {
          if (seq === seqRef.current) setResults(res.users)
        })
        .catch(() => {
          if (seq === seqRef.current) setResults([])
        })
        .finally(() => {
          if (seq === seqRef.current) setLoading(false)
        })
    }, 200)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [query, value])

  if (value) {
    return (
      <div
        className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
        data-testid={`${testid}-selected`}
      >
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">
            {value.display_name || value.username}
          </div>
          <div className="truncate text-xs text-muted-foreground">{value.email}</div>
        </div>
        <button
          type="button"
          aria-label="Clear selection"
          className="text-muted-foreground hover:text-foreground"
          data-testid={`${testid}-clear`}
          onClick={() => {
            onChange(null)
            setQuery('')
          }}
        >
          <X className="size-4" />
        </button>
      </div>
    )
  }

  const visible = results.filter(u => !excluded.has(u.id))

  return (
    <div className="flex flex-col gap-2">
      <Input
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder={placeholder ?? 'Search users by name or email'}
        data-testid={`${testid}-search`}
      />
      <div className="max-h-56 overflow-y-auto rounded-md border" data-testid={`${testid}-results`}>
        {loading ? (
          <div className="flex justify-center py-4">
            <Spinner label="Searching users" />
          </div>
        ) : visible.length === 0 ? (
          <div className="px-3 py-4 text-sm text-muted-foreground" data-testid={`${testid}-empty`}>
            No matching users
          </div>
        ) : (
          <div className="flex flex-col divide-y">
            {visible.map(u => (
              <button
                key={u.id}
                type="button"
                className="flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-accent"
                data-testid={`${testid}-option-${u.id}`}
                onClick={() => onChange(u)}
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{u.display_name || u.username}</div>
                  <div className="truncate text-xs text-muted-foreground">{u.email}</div>
                </div>
                {!u.is_active && (
                  <Tag variant="outline" data-testid={`${testid}-inactive-${u.id}`}>
                    inactive
                  </Tag>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
