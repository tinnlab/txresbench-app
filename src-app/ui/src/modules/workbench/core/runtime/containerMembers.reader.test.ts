// The `container_members` SLICE READER (`readContainerMembersSlice` in `viewData.ts`) —
// the only non-pure half of the source, and the only half that can be wired to the WRONG
// container. The pure suite (`containerMembers.test.ts`) feeds the resolver a declaration
// directly; this file drives the READER through the real dispatch (`readSliceFromApi`)
// against the real client-side datatype registry, so the wiring — "the members of the
// datatype the slice's `args.datatype` NAMES" — is what is under test.
//
// The fixtures carry NO domain vocabulary: every datatype id and member name here is
// neutral, for the same reason the pure suite's are.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Datatype } from '@/core/datatypes/types'
import { datatypeRegistry } from '@/core/datatypes/registry'
import type { DataSourceSpec } from '@/modules/workbench/core/manifest/viewSpec'
import { readSliceFromApi } from './viewData'

/** A minimal manifest datatype fixture — only `input_requirements` is load-bearing. */
function manifestDatatype(id: string, members: string[]): Datatype {
  return {
    id,
    extends: 'data/opaque',
    title: id,
    description: '',
    storage: {
      layout: { kind: 'opaque_as_is' },
      format: 'opaque',
      selector_map: {},
      file_layout: 'manifest',
      tiers: [],
    },
    capabilities: [],
    viewers: [],
    converters: [],
    input_requirements: { requires: 'manifest', members, allow_archive: true },
    is_abstract: false,
  } as unknown as Datatype
}

/** A minimal single-file datatype fixture. */
function singleDatatype(id: string): Datatype {
  return {
    id,
    extends: 'data/opaque',
    title: id,
    description: '',
    storage: {
      layout: { kind: 'opaque_as_is' },
      format: 'opaque',
      selector_map: {},
      file_layout: 'single',
      tiers: [],
    },
    capabilities: [],
    viewers: [],
    converters: [],
    input_requirements: { requires: 'single' },
    is_abstract: false,
  } as unknown as Datatype
}

/** A `container_members` slice declaration. */
function slice(args?: Record<string, unknown>): DataSourceSpec {
  return { source: 'container_members', args } as DataSourceSpec
}

describe('readContainerMembersSlice — the container_members slice reader', () => {
  // The registry is a process-wide singleton; save and restore it so this suite cannot
  // leak its seeds into a sibling suite (or inherit theirs).
  let original: Datatype[]
  beforeEach(() => {
    original = datatypeRegistry.all()
  })
  afterEach(() => {
    datatypeRegistry.replaceAll(original)
  })

  it('returns the members of the datatype args.datatype NAMES — not the first manifest datatype in the registry', async () => {
    // A DECOY manifest container is registered FIRST, so a reader that "takes the first
    // manifest datatype" would answer the decoy. The reader must answer the NAMED one —
    // in the real app the registry holds dozens of manifest datatypes, so "first" and
    // "the one the slice names" are different answers.
    datatypeRegistry.replaceAll([
      manifestDatatype('test/decoy', ['decoy_001/a.csv']),
      manifestDatatype('test/real', ['group_002/a.csv', 'group_008/b.csv']),
    ])
    const res = await readSliceFromApi({} as never, 'groups', slice({ datatype: 'test/real' }))
    expect(res).toEqual({
      status: 'ready',
      payload: [
        { value: 2, label: 'group_002' },
        { value: 8, label: 'group_008' },
      ],
    })
  })

  it('a bogus/unknown args.datatype returns the EMPTY status — not an error, not a throw', async () => {
    datatypeRegistry.replaceAll([manifestDatatype('test/real', ['group_002/a.csv'])])
    const res = await readSliceFromApi(
      {} as never,
      'groups',
      slice({ datatype: 'test/does-not-exist' }),
    )
    expect(res).toEqual({ status: 'empty' })
  })

  it('absent args (and absent args.datatype) returns the EMPTY status', async () => {
    datatypeRegistry.replaceAll([manifestDatatype('test/real', ['group_002/a.csv'])])
    expect(await readSliceFromApi({} as never, 'groups', slice())).toEqual({ status: 'empty' })
    expect(await readSliceFromApi({} as never, 'groups', slice({}))).toEqual({ status: 'empty' })
  })

  it('a datatype whose input_requirements.requires is `single` returns EMPTY', async () => {
    datatypeRegistry.replaceAll([singleDatatype('test/single')])
    const res = await readSliceFromApi({} as never, 'groups', slice({ datatype: 'test/single' }))
    expect(res).toEqual({ status: 'empty' })
  })
})
