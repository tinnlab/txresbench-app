import { describe, it, expect } from 'vitest'
import type { ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import { projectViewSpecCapabilities } from './aiCapabilities'

// The `view_spec` -> AI-capability projection. This is the half that MOVED: the
// backend used to derive it by re-parsing the YAML with a partial Rust mirror of
// this runtime's schema. These tests pin the projection here, on the side that
// owns the document, so the shape the agent is offered is the shape a declared
// action actually has.
//
// Ids are deliberately domain-neutral: the projection is package-agnostic and a
// test written against a shipped package's real ids would read as though it knew
// something about that package. It does not.

function spec(overrides: Partial<ViewSpec> = {}): ViewSpec {
  return {
    id: 'demo.view',
    title: 'Demo view',
    permission: 'jobs::use',
    state: {},
    widgets: [],
    actions: [],
    ...overrides,
  } as ViewSpec
}

function action(overrides: Record<string, unknown> = {}) {
  return {
    id: 'd.first',
    title: 'First',
    permission: 'jobs::use',
    params: {},
    body: [],
    ...overrides,
  } as never
}

function byId(capabilities: ReturnType<typeof projectViewSpecCapabilities>) {
  return capabilities.map(c => c.id)
}

describe('projectViewSpecCapabilities', () => {
  it('namespaces each declared action and appends the synthesized describe', () => {
    const got = projectViewSpecCapabilities(
      spec({ actions: [action(), action({ id: 'd.second', title: 'Second' })] }),
    )
    expect(byId(got)).toEqual([
      'demo.view::d.first',
      'demo.view::d.second',
      'demo.view::describe',
    ])
  })

  it('carries the declared metadata onto the capability', () => {
    const [first] = projectViewSpecCapabilities(
      spec({
        actions: [
          action({
            mutating: true,
            stateful: true,
            context: 'workbench',
            description: 'Does the first thing.',
            params: { index: 'number' },
          }),
        ],
      }),
    )
    expect(first).toMatchObject({
      id: 'demo.view::d.first',
      title: 'First',
      kind: 'instance',
      mutating: true,
      stateful: true,
      context: 'workbench',
      permission: 'jobs::use',
      description: 'Does the first thing.',
    })
  })

  it('defaults mutating/stateful/context/title when the declaration omits them', () => {
    const [only] = projectViewSpecCapabilities(
      spec({ actions: [action({ title: undefined })] }),
    )
    expect(only).toMatchObject({
      title: 'd.first',
      mutating: false,
      stateful: false,
      context: 'global',
    })
    expect(only.description).toBeUndefined()
  })

  it('always requires view_id, then each declared param in declaration order', () => {
    const [only] = projectViewSpecCapabilities(
      spec({ actions: [action({ params: { index: 'number', label: 'string' } })] }),
    )
    expect(only.params_schema).toEqual({
      type: 'object',
      required: ['view_id', 'index', 'label'],
      additionalProperties: false,
      properties: {
        view_id: { type: 'string' },
        index: { type: 'number' },
        label: { type: 'string' },
      },
    })
  })

  it('never double-declares view_id when the action names it too', () => {
    const [only] = projectViewSpecCapabilities(
      spec({ actions: [action({ params: { view_id: 'string', value: 'string' } })] }),
    )
    expect(only.params_schema).toMatchObject({ required: ['view_id', 'value'] })
  })

  it('maps the loose param type vocabulary to JSON Schema', () => {
    const [only] = projectViewSpecCapabilities(
      spec({
        actions: [
          action({
            params: {
              s: 'string',
              n: 'number',
              i: 'integer',
              f: 'float',
              b: 'boolean',
              b2: 'bool',
              arr: '[number, number]',
              list: 'list<string>',
              m: 'map<string, number>',
              o: 'object',
              nested: { a: 1 },
              seq: ['a'],
              weird: 'weird',
            },
          }),
        ],
      }),
    )
    const props = (only.params_schema as { properties: Record<string, unknown> }).properties
    expect(props.s).toEqual({ type: 'string' })
    expect(props.n).toEqual({ type: 'number' })
    expect(props.i).toEqual({ type: 'number' })
    expect(props.f).toEqual({ type: 'number' })
    expect(props.b).toEqual({ type: 'boolean' })
    expect(props.b2).toEqual({ type: 'boolean' })
    expect(props.arr).toEqual({ type: 'array' })
    expect(props.list).toEqual({ type: 'array' })
    expect(props.m).toEqual({ type: 'object' })
    expect(props.o).toEqual({ type: 'object' })
    expect(props.nested).toEqual({ type: 'object' })
    expect(props.seq).toEqual({ type: 'array' })
    // An unknown declaration degrades OPEN — the interpreter, not this schema,
    // is the authority on a complex param's shape.
    expect(props.weird).toEqual({})
  })

  it('drops an action that opts out of the AI surface', () => {
    const got = projectViewSpecCapabilities(
      spec({
        actions: [
          action({ id: 'd.hidden', surfaces: { ai: false } }),
          action({ id: 'd.shown' }),
        ],
      }),
    )
    expect(byId(got)).toEqual(['demo.view::d.shown', 'demo.view::describe'])
  })

  it('keeps an action that opts out of the PALETTE only', () => {
    const got = projectViewSpecCapabilities(
      spec({ actions: [action({ id: 'd.aiOnly', surfaces: { palette: false } })] }),
    )
    expect(byId(got)).toContain('demo.view::d.aiOnly')
  })

  it('gates the synthesized describe on the VIEW-level permission', () => {
    const got = projectViewSpecCapabilities(spec({ permission: 'mcp::use' }))
    expect(got).toEqual([
      {
        id: 'demo.view::describe',
        title: 'Describe Demo view',
        kind: 'instance',
        mutating: false,
        stateful: false,
        context: 'global',
        permission: 'mcp::use',
        description: 'Read the live state + derived values of the "Demo view" view.',
        params_schema: {
          type: 'object',
          required: ['view_id'],
          additionalProperties: false,
          properties: { view_id: { type: 'string' } },
        },
      },
    ])
  })

  it('is idempotent over an already-namespaced declared id', () => {
    const got = projectViewSpecCapabilities(
      spec({ actions: [action({ id: 'demo.view::d.first' })] }),
    )
    expect(byId(got)).toEqual(['demo.view::d.first', 'demo.view::describe'])
  })

  it('does not filter a permission-less action — the backend rules on that, fail-closed', () => {
    // Duplicating the backend's judgement here would hide an authoring mistake
    // from the one place authorized to make it (and `parseViewSpec` already
    // refuses such a spec upstream).
    const got = projectViewSpecCapabilities(
      spec({ actions: [action({ id: 'd.ungated', permission: '' })] }),
    )
    expect(byId(got)).toContain('demo.view::d.ungated')
  })
})
