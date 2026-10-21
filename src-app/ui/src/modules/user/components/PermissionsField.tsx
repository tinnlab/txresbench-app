import { Search } from 'lucide-react'
import { Input, Switch, Textarea, Tree, Text } from '@ziee/kit'
import type { TreeProps } from '@ziee/kit'
import { useMemo, useState } from 'react'
import { PermissionDescriptions } from '@/api-client/permissionDescriptions'
import { Permissions } from '@/api-client/permissions'

// ---------------------------------------------------------------------------
// Permission catalog — derived once from the generated client metadata.
//
// `Permissions` maps PascalCase name -> permission string ("users::read"),
// `PermissionDescriptions` maps the same name -> human description. Both are
// emitted into api-client/types.ts by the OpenAPI generator, so the picker
// needs no backend endpoint. Group by the leading "::" segment.
// ---------------------------------------------------------------------------

interface PermOption {
  value: string // e.g. "users::read"
  description: string
  group: string // e.g. "users"
}

const PERM_OPTIONS: PermOption[] = Object.entries(Permissions)
  .map(([name, value]) => ({
    value,
    description: PermissionDescriptions[name] ?? '',
    group: value.split('::')[0],
  }))
  .sort((a, b) => a.value.localeCompare(b.value))

const KNOWN_VALUES = new Set(PERM_OPTIONS.map(o => o.value))

const ALL_GROUP_KEYS = Array.from(
  new Set(PERM_OPTIONS.map(o => `group:${o.group}`)),
)

// "llm_providers" -> "Llm Providers"
function prettifyGroup(group: string): string {
  return group
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

// Wildcards are valid assignable values even though they aren't enum members:
// "*" (global) and "module::resource::*" (hierarchical). The Administrators
// group is seeded with ["*"]. Accept those in the Advanced JSON editor.
const WILDCARD_RE = /^[a-z0-9_]+(::[a-z0-9_]+)*::\*$/
export function isValidPermissionToken(v: string): boolean {
  return KNOWN_VALUES.has(v) || v === '*' || WILDCARD_RE.test(v)
}

// ---------------------------------------------------------------------------

interface PermissionsFieldProps {
  // Injected by antd Form.Item (value/onChange contract).
  value?: string[]
  onChange?: (next: string[]) => void
  // Form `disabled` does not auto-propagate to custom children — pass it.
  disabled?: boolean
}

export function PermissionsField({
  value = [],
  onChange,
  disabled,
}: PermissionsFieldProps) {
  const [advanced, setAdvanced] = useState(false)
  const [search, setSearch] = useState('')
  const [jsonText, setJsonText] = useState('')
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [expandedKeys, setExpandedKeys] = useState<string[]>(ALL_GROUP_KEYS)
  const [autoExpandParent, setAutoExpandParent] = useState(false)

  // Split the value into picker-managed permissions and "extra" entries
  // (wildcards / unknown strings). Extra entries are preserved verbatim on
  // every save — the picker only owns the known set.
  const knownChecked = useMemo(
    () => value.filter(v => KNOWN_VALUES.has(v)),
    [value],
  )
  const extra = useMemo(() => value.filter(v => !KNOWN_VALUES.has(v)), [value])

  const searching = search.trim().length > 0

  const treeData = useMemo(() => {
    const q = search.trim().toLowerCase()
    const groups = new Map<string, PermOption[]>()
    for (const opt of PERM_OPTIONS) {
      if (
        q &&
        !opt.value.toLowerCase().includes(q) &&
        !opt.description.toLowerCase().includes(q)
      ) {
        continue
      }
      const arr = groups.get(opt.group) ?? []
      arr.push(opt)
      groups.set(opt.group, arr)
    }
    return Array.from(groups.entries()).map(([group, opts]) => ({
      key: `group:${group}`,
      title: prettifyGroup(group),
      children: opts.map(o => ({
        key: o.value,
        // Stack value + description as blocks (not inline siblings): once the
        // row wraps, two inline spans' bounding rects share the same lines and
        // read as overlapping (A2). A flex column keeps each on its own rows and
        // lets long tokens/descriptions wrap freely.
        title: (
          <span className="flex flex-col">
            <Text className="font-mono text-xs [overflow-wrap:anywhere]">{o.value}</Text>
            {o.description && (
              <Text type="secondary" className="text-xs [overflow-wrap:anywhere]">
                {o.description}
              </Text>
            )}
          </span>
        ),
      })),
    }))
  }, [search])

  // When searching, force every matched group open; otherwise honor the
  // user's expand/collapse state.
  const shownExpanded = searching ? treeData.map(g => g.key) : expandedKeys

  // Derive the next value from the full checked keys provided by the kit Tree.
  // Filter out parent group keys (not in KNOWN_VALUES) that may appear due to conduction.
  const handleCheck: NonNullable<TreeProps['onCheck']> = (keys) => {
    const next = new Set(keys.filter(k => KNOWN_VALUES.has(k)))
    onChange?.([...next, ...extra])
  }

  const handleExpand: NonNullable<TreeProps['onExpand']> = keys => {
    setExpandedKeys(keys)
    setAutoExpandParent(false)
  }

  const enterAdvanced = () => {
    setJsonText(JSON.stringify(value, null, 2))
    setJsonError(null)
    setAdvanced(true)
  }

  const handleJsonChange = (text: string) => {
    setJsonText(text)
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      setJsonError('Invalid JSON format')
      return
    }
    if (!Array.isArray(parsed)) {
      setJsonError('Must be an array')
      return
    }
    const invalid = parsed.filter(
      p => typeof p !== 'string' || !isValidPermissionToken(p),
    )
    if (invalid.length > 0) {
      setJsonError(`Invalid permissions: ${invalid.join(', ')}`)
      return
    }
    setJsonError(null)
    onChange?.(parsed as string[])
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        {advanced ? (
          <span className="flex-1" />
        ) : (
          <Input
            className="flex-1"
            size="sm"
            allowClear
            disabled={disabled}
            prefix={<Search aria-hidden="true" />}
            placeholder="Search permissions"
            aria-label="Search permissions"
            data-testid="user-permissions-search-input"
            value={search}
            onChange={e => {
              setSearch(e.target.value)
              setAutoExpandParent(true)
            }}
          />
        )}
        <span className="flex items-center gap-2 whitespace-nowrap">
          <Text type="secondary" className="text-xs">
            Advanced JSON
          </Text>
          <Switch
            size="sm"
            checked={advanced}
            disabled={disabled}
            tooltip="Advanced JSON"
            data-testid="user-permissions-advanced-switch"
            onChange={checked => (checked ? enterAdvanced() : setAdvanced(false))}
          />
        </span>
      </div>

      {advanced ? (
        <>
          <Textarea
            aria-label="Permissions (JSON Array)"
            data-testid="user-permissions-json-textarea"
            className="font-mono"
            rows={8}
            disabled={disabled}
            value={jsonText}
            placeholder={`["${Permissions.UsersRead}", "${Permissions.UsersEdit}"]`}
            onChange={e => handleJsonChange(e.target.value)}
          />
          {jsonError && (
            <Text type="danger" role="alert" className="text-xs" data-testid="user-permissions-json-error">
              {jsonError}
            </Text>
          )}
        </>
      ) : (
        <>
          {/* p-2 + scroll-py-2 keep each row's 3px focus ring off the scroll
              clip edge (G7) rather than the flush p-1 that shaved it. */}
          <div className="max-h-80 overflow-auto p-2 scroll-py-2 border rounded">
            {treeData.length > 0 ? (
              <Tree
                checkable
                aria-label="Permissions tree"
                data-testid="user-permissions-tree"
                treeData={treeData}
                checkedKeys={knownChecked}
                onCheck={disabled ? undefined : handleCheck}
                expandedKeys={shownExpanded}
                autoExpandParent={searching || autoExpandParent}
                onExpand={handleExpand}
              />
            ) : (
              <div className="p-2">
                <Text type="secondary" className="text-xs">
                  No permissions match "{search}"
                </Text>
              </div>
            )}
          </div>
          {extra.length > 0 && (
            <Text type="secondary" className="text-xs" data-testid="user-permissions-extra-note">
              + {extra.length} advanced{' '}
              {extra.length === 1 ? 'entry' : 'entries'}: {extra.join(', ')} —
              edit in Advanced JSON
            </Text>
          )}
        </>
      )}
    </div>
  )
}
