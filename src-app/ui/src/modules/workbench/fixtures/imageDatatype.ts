// The NON-single-cell drop-in fixture (dimension-primitives ITEM-7, INV-3 — the
// un-gameable separability proof). A microscopy IMAGE datatype declared PURELY as DATA —
// it shares ZERO code with the single-cell domain and names no single-cell concept.
// Registered through the REAL FE datatype registry (`datatypeRegistry`), it proves a
// contributor lands a fully-typed dimension with ZERO app edit beyond this DATA.
//
// The typing MECHANISM is the artifact, not a declaration (INV-5). This fixture used to
// carry the forecast on both levels — `AxisSpec.annotations` here plus the producing
// analysis' `produces_annotations` — and both are deleted along with the types that held
// them. What makes its columns typed now is (a) the package registering the datatypes its
// column artifacts carry, with their catalog capabilities, and (b) its run EMITTING
// artifacts that STAMP their own kind, a stamp the conformance gate verifies.
// (ITEM-39 deleted the four general dimension primitives this fixture used to DRIVE;
// what it proves now is the artifact → `annotationsForAxis` path, not a widget.)
//
// It is a TEST / gallery fixture (not a shipped production datatype): it goes through the
// same real registration + primitive path a production datatype would, but is registered
// only where a test / the gallery / an e2e seed asks for it — never from `/api/datatypes`.

import { datatypeRegistry, type Datatype } from '@/core/datatypes'
import { WORKBENCH_API_VERSION, workbenchRegistry, type AnalysisContribution } from '@/modules/workbench/core'

/** The fixture datatype id — a non-single-cell image (deliberately NOT `single-cell/*`). */
export const IMAGE_FIXTURE_DATATYPE_ID = 'fixture/image'

/**
 * A microscopy image datatype — dimensions `{height, width, channel}` plus a derived
 * `region` (segmented-object) axis, each declared as DATA with IDENTITY ONLY (the same
 * `AxisSpec` shape the single-cell manifest uses). NO single-cell concept appears anywhere.
 */
export const imageDatatype: Datatype = {
  id: IMAGE_FIXTURE_DATATYPE_ID,
  extends: 'matrix',
  title: 'Microscopy image',
  description: 'A multi-channel microscopy image (height × width × channel) with segmented regions.',
  is_abstract: false,
  schema: {
    type: 'object',
    properties: {
      height: { type: 'integer', minimum: 0 },
      width: { type: 'integer', minimum: 0 },
      channel: { type: 'integer', minimum: 0 },
    },
  },
  storage: {
    layout: { kind: 'chunked_dense' },
    format: 'zarr',
    selector_map: {
      channel: { index: 'column' },
      region: { index: 'row' },
    },
    file_layout: 'single',
    tiers: ['tier1_range_client_decode', 'tier2_layout_slice'],
  },
  capabilities: ['sliceable'],
  viewers: [],
  converters: [],
  ingest: { extensions: ['tif', 'tiff', 'ome.tif'], magic_hex: [] },
  // The declared axes carry IDENTITY ONLY (INV-5). Each used to enumerate the columns the
  // axis "would" carry, typed — a forecast written before any run existed. `AxisSpec` no
  // longer has a field to hold one, so the fixture cannot ship one even as a witness; the
  // columns it really contributes come from the artifacts its run stamps (see
  // `nonSingleCellDropin.test.ts`, which registers a legacy forecast of its own to prove
  // the runtime ignores it).
  axes: [
    { name: 'height', key_label: 'row' },
    { name: 'width', key_label: 'column' },
    { name: 'channel', key_label: 'channel_id' },
    { name: 'region', key_label: 'region_id' },
  ],
  // The ENTITY axis, declared by NAME. This fixture is the acceptance case for the
  // positional leak: three of its four axes are RASTER dimensions, and the axis a value
  // of this type has one PER is the LAST declared one. Under the former `axes[0]` rule
  // its entity axis resolved to `height` — a picture's pixel rows standing in for its
  // segmented objects, setting every point count and dense column extent downstream.
  // Nothing named `height` was ever wrong-looking, which is why it survived: the failure
  // mode of a mis-picked entity axis is a plausible number, not an exception.
  entity_axis: 'region',
  input_requirements: { requires: 'single' },
}

/**
 * A fixture analysis producing columns on the image fixture's `region` axis. It declares
 * only WHICH datatype it produces; the type of each column that actually lands is read off
 * that artifact's stamp (INV-5). Its `produces_annotations` block — the producer half of
 * the forecast, which named `pct_positive` before any run could write it — is deleted with
 * the field that held it.
 *
 * ITEM-39 emptied its `params.fields`: it declared one field per general dimension
 * primitive (`category-group` / `annotation-filter` ×2 / `dimension-selector` /
 * `dimension-stats`), and those widget kinds are deleted — no shipping processor spec
 * ever instantiated one. Keeping the declarations would name widget kinds nothing can
 * resolve. What this fixture is still FOR is the NON-single-cell drop-in claim: a package
 * from another domain contributing typed columns with zero core edits.
 */
export const imageFixtureAnalysis: AnalysisContribution = {
  id: 'fixture.image-selection',
  launchable: false,
  extensionId: 'txr.workbench.fixtures',
  apiVersion: WORKBENCH_API_VERSION,
  title: 'Region selection (image fixture)',
  category: 'fixture',
  description: 'Typed produced columns on the image regions axis — the non-single-cell drop-in proof.',
  whenHint: 'the user wants to select or compare regions of an image',
  examples: ['compare two region classes', 'select bright regions'],
  safety: 'read-run',
  appliesTo: [],
  // `produces` (WHICH datatype) is the whole output contract. The `produces_annotations`
  // block that used to sit here named each output column and its type before any run
  // existed — the producer half of the deleted forecast (INV-5). `AnalysisContribution` has
  // no such field, and the processor loader hard-fails a manifest still declaring the key.
  produces: ['fixture/image'],
  run: { kind: 'sandbox', runtime: 'python', entry: 'compute/fixture-image.py' },
  schedule: { class: 'interactive', resources: { cpu: 1, mem: '1Gi' } },
} as AnalysisContribution

/** Merge the fixture datatype into the FE registry AND register its producing analysis
 *  (idempotent) — the REAL registration path a test / the gallery / an e2e seed uses to
 *  drive the general primitives from its declared DATA. Registering the analysis into
 *  `workbenchRegistry.analyses` is what lets the DEFAULT (registry-backed)
 *  `annotationsForAxis` read the fixture's `produces_annotations` (dimension-primitives
 *  D-7 / INV-2), so a produced custom metric drives the UI end-to-end. A no-op once present. */
export function registerImageFixture(): void {
  if (!datatypeRegistry.get(IMAGE_FIXTURE_DATATYPE_ID)) {
    datatypeRegistry.replaceAll([...datatypeRegistry.all(), imageDatatype])
  }
  if (!workbenchRegistry.analyses.has(imageFixtureAnalysis.id)) {
    workbenchRegistry.analyses.register(imageFixtureAnalysis)
  }
}
