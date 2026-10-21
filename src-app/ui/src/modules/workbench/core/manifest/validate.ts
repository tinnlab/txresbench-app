// The FE manifest validator (ITEM-15). parse → validate → apiVersion gate →
// index WITHOUT executing extension code. Kept dependency-free (DEC-9, no ajv):
// built-in manifests are trusted first-party, so slice-1 does explicit STRUCTURAL
// validation against `ExtensionManifest` + the semver `apiVersion` gate. The
// published `schema.json` is the SoT contract that the external-loader slice
// (untrusted manifests) + the BE serde mirror validate against with a full
// JSON-schema engine.
//
// YAML→object parsing is the HOST loader's job (vite yaml import / a yaml dep in
// the external-loader slice); `validateManifest` accepts a parsed object OR a
// JSON string. It NEVER invokes a lazy code ref (`run`/`component`) — indexing is
// pure metadata (§3).

import type { ExtensionManifest } from './types.ts'
import { isApiVersionCompatible } from '../version.ts'

export interface ValidationError {
  path: string
  message: string
}

export interface ValidationResult {
  ok: boolean
  manifest?: ExtensionManifest
  errors: ValidationError[]
}

/** The extension-id charset — MUST equal schema.json's `properties.id.pattern`. */
const MANIFEST_ID_RE = /^[a-z0-9][a-z0-9._-]*$/

/** The contribution keys a manifest may declare. Superset of the registry-backed
 *  `CONTRIBUTION_KINDS` (it also carries the declarative-backend keys settings/
 *  jobs/artifactKinds/sidecar). Exported so a test guards the two lists against
 *  drift (audit EXT-2). */
export const KNOWN_CONTRIBUTES = new Set([
  'analyses',
  'sections',
  'views',
  'statusBarItems',
  'settings',
  'jobs',
  'artifactKinds',
  'sidecar',
])

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Validate + index a manifest. `input` is a parsed object or a JSON string.
 * `hostVersion` defaults to the current `WORKBENCH_API_VERSION`.
 */
export function validateManifest(input: unknown, hostVersion?: string): ValidationResult {
  const errors: ValidationError[] = []
  let obj: unknown = input
  if (typeof input === 'string') {
    try {
      obj = JSON.parse(input)
    } catch (e) {
      return { ok: false, errors: [{ path: '$', message: `not valid JSON: ${(e as Error).message}` }] }
    }
  }
  if (!isObject(obj)) {
    return { ok: false, errors: [{ path: '$', message: 'manifest must be an object' }] }
  }

  const req = (key: string) => {
    if (typeof obj[key] !== 'string' || (obj[key] as string).length === 0) {
      errors.push({ path: `$.${key}`, message: `required string "${key}" missing` })
    }
  }
  req('id')
  req('name')
  req('version')
  req('apiVersion')

  // Enforce the id charset from schema.json (`^[a-z0-9][a-z0-9._-]*$`). This is
  // security-relevant, not cosmetic: the per-extension `storage` KV namespaces by
  // `ext:<id>:`, so a `:` in an id would make the prefix non-injective and let one
  // extension collide with another's keys (audit SEC-1). Keeping this in lockstep
  // with schema.json until the external-loader slice runs a full JSON-schema engine.
  if (typeof obj.id === 'string' && obj.id.length > 0 && !MANIFEST_ID_RE.test(obj.id)) {
    errors.push({ path: '$.id', message: `id "${obj.id}" must match ${MANIFEST_ID_RE} (lowercase alnum + . _ -)` })
  }

  // apiVersion compatibility gate (§6) — refuse an out-of-range extension.
  if (typeof obj.apiVersion === 'string') {
    if (!isApiVersionCompatible(obj.apiVersion, hostVersion)) {
      errors.push({
        path: '$.apiVersion',
        message: `apiVersion "${obj.apiVersion}" is incompatible with host ${hostVersion ?? 'current'}`,
      })
    }
  }

  // contributes shape — reject an unknown contribution key (typo guard).
  if (obj.contributes !== undefined) {
    if (!isObject(obj.contributes)) {
      errors.push({ path: '$.contributes', message: 'contributes must be an object' })
    } else {
      for (const key of Object.keys(obj.contributes)) {
        if (!KNOWN_CONTRIBUTES.has(key)) {
          errors.push({ path: `$.contributes.${key}`, message: `unknown contribution kind "${key}"` })
        }
      }
    }
  }

  if (obj.activation !== undefined && !Array.isArray(obj.activation)) {
    errors.push({ path: '$.activation', message: 'activation must be an array of event strings' })
  }
  if (obj.dependencies !== undefined && !Array.isArray(obj.dependencies)) {
    errors.push({ path: '$.dependencies', message: 'dependencies must be an array of extension ids' })
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, manifest: obj as unknown as ExtensionManifest, errors: [] }
}
