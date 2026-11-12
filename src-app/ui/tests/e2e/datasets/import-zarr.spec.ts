import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { BACKEND, findDatasetRow, loginOwnerToDatasets, ownerToken } from './_helpers'

// TEST-34 [artifact-model · ITEM-26] — a REAL import, driven through the UI, and its
// artifacts read back through the SHIPPED client reader.
//
// ITEM-26 turned an axis index from a single JSON file into a Zarr STORE — a directory of
// members with a producer-declared decode contract. That change is only proven end to end
// if a genuine import writes one and the browser's own reader decodes it, so this spec
// does exactly that and mocks nothing:
//
//   1. a real, committed input is uploaded through the real upload dialog;
//   2. the deployment's own on-ingest converter runs it for real, in the sandbox, and the
//      UI's processing badge is what reports completion;
//   3. the emitted axis indexes are asserted to be DIRECTORIES, not files;
//   4. the shipped reader (`window.__txr_read`) decodes the served bytes in the page, and
//      the ordered key sequence it recovers is checked against the digest the PRODUCER
//      declared at write time — two independent sources, so a matching digest cannot be
//      manufactured by this spec.
//
// NOTHING HERE IS NAMED. The spec never hardcodes an input file, an extension, a converter
// or an axis label: it asks `GET /extensions` which types the on-ingest converter accepts,
// asks `GET /datatypes` which extensions ingest those types, picks the smallest committed
// fixture that matches, and selects the axis indexes by the predicate the SERVER resolves
// them with (`meta.is_axis_index`). That is not lint-dodging — it is INV-3 ("an axis IS its
// key artifact; its name is only a label") applied to the test, so a renamed output or a
// changed input format cannot make this spec quietly stop covering anything.
//
// NOT `@acceptance`-tagged, and it does not skip: it runs in a default `npx playwright
// test`. The rootfs the sandbox needs is fetched and cached by the backend itself on first
// use, so a host that cannot obtain one FAILS here, loudly, with the converter's own error.
//
// WHAT THIS DOES NOT COVER — recorded, not implied:
//   • Not every emitted artifact is decoded. The run's artifacts are all fetched and their
//     declarations asserted, but only those DECLARING themselves an axis index are read
//     back through the reader — those are the ones ITEM-26 changed. The matrix and the
//     opaque reports are not decoded here.
//   • The converter is the AUTO-ENQUEUED on-ingest run, so no Run control is pressed. The
//     upload journey is real UI; the user-initiated launch surface is not this spec's.
//   • The reader is exercised through the `__txr_read` seam — the shipped decoder itself,
//     over real HTTP — but not through a PAINTED surface. A regression that decodes
//     correctly and then fails to bind into a view would pass here.

const HERE = dirname(fileURLToPath(import.meta.url))

/** Where the suite keeps its committed, genuinely-importable inputs. The spec picks one
 *  from here BY TYPE (see `singleFileInputTypes`), never by name. */
const INPUT_FIXTURE_DIR = resolve(HERE, '../14-declarative-qc/fixtures')

const auth = (token: string) => ({ authorization: `Bearer ${token}` })

interface ConverterAccept {
  type_id: string
  role: string
}
interface ExtensionManifest {
  id: string
  contributes?: { converters?: { id: string; trigger?: string; accepts?: ConverterAccept[] }[] }
}
interface DatatypeRow {
  id: string
  title?: string
  ingest?: { extensions?: string[] } | null
  input_requirements?: { requires?: string } | null
}

/** One input type the upload dialog can be driven with: its registry title (the option
 *  label the dialog renders) and the extensions that ingest into it. */
interface InputType {
  id: string
  title: string
  extensions: string[]
}

interface ArtifactRow {
  id: string
  output_id: string
  datatype: string
  is_multifile: boolean
  structure: Record<string, unknown>
  meta: Record<string, unknown>
}

/** A declared column of a `zarr_v3` table structure. */
interface DeclaredColumn {
  name?: string
  path?: string
  kind?: string
  layout?: string
  offsets?: string
  values?: string
}

/**
 * The single-file input types this deployment auto-converts on ingest — derived, never
 * assumed. Three DECLARATIONS are composed, all of them server-side DATA:
 *   • the on-ingest converter says which type ids it accepts as a PRIMARY input;
 *   • the datatype registry says which of those take ONE file (`input_requirements`) —
 *     the shape the upload dialog reveals a single dropzone for;
 *   • …and which extensions ingest into each (`ingest.extensions`).
 *
 * Every step is asserted non-empty. A deployment that can auto-import nothing must read as
 * a failure here, not as a spec that quietly picks nothing to upload.
 */
async function singleFileInputTypes(
  request: APIRequestContext,
  token: string,
): Promise<{ types: InputType[]; converterId: string }> {
  const extRes = await request.get(`${BACKEND}/api/extensions`, { headers: auth(token) })
  expect(extRes.ok(), `GET /extensions (${extRes.status()})`).toBeTruthy()
  const manifests = (await extRes.json()) as ExtensionManifest[]

  const converters = manifests
    .flatMap(m => m.contributes?.converters ?? [])
    .filter(c => c.trigger === 'on-ingest')
  expect(
    converters.length,
    'the deployment declares at least one on-ingest converter — without one no upload is ever imported, ' +
      'and this spec would be asserting over an empty set',
  ).toBeGreaterThan(0)

  const converter = converters[0]
  const typeIds = (converter.accepts ?? []).filter(a => a.role === 'primary').map(a => a.type_id)
  expect(typeIds.length, `converter "${converter.id}" accepts at least one primary input type`).toBeGreaterThan(0)

  const dtRes = await request.get(`${BACKEND}/api/datatypes`, { headers: auth(token) })
  expect(dtRes.ok(), `GET /datatypes (${dtRes.status()})`).toBeTruthy()
  const datatypes = (await dtRes.json()) as DatatypeRow[]

  const types = datatypes
    .filter(t => typeIds.includes(t.id))
    .filter(t => t.input_requirements?.requires === 'single')
    .map(t => ({
      id: t.id,
      title: t.title ?? t.id,
      extensions: (t.ingest?.extensions ?? []).map(e => e.toLowerCase()),
    }))
    .filter(t => t.extensions.length > 0)

  expect(
    types.map(t => t.id),
    `none of converter "${converter.id}"'s primary types (${typeIds.join(', ')}) both takes a single ` +
      'file and declares an ingest extension — there is no one-file upload journey to drive',
  ).not.toEqual([])
  return { types, converterId: converter.id }
}

/** The smallest committed fixture the deployment auto-converts, paired with the input type
 *  it ingests as. Smallest = fastest real conversion; any of them would prove the same. */
function smallestImportableFixture(types: InputType[]): { path: string; extension: string; type: InputType } {
  const candidates = readdirSync(INPUT_FIXTURE_DIR)
    .map(name => ({ name, path: join(INPUT_FIXTURE_DIR, name) }))
    .filter(f => statSync(f.path).isFile())
    .map(f => ({ ...f, extension: extname(f.name).replace(/^\./, '').toLowerCase() }))
    .flatMap(f => {
      const type = types.find(t => t.extensions.includes(f.extension))
      return type ? [{ path: f.path, extension: f.extension, type, size: statSync(f.path).size }] : []
    })
    .sort((a, b) => a.size - b.size)

  expect(
    candidates.length,
    `no committed fixture under ${INPUT_FIXTURE_DIR} carries an auto-convertible extension ` +
      `(${types.flatMap(t => t.extensions).join(', ')}) — this spec needs a real input to import`,
  ).toBeGreaterThan(0)
  const { path, extension, type } = candidates[0]
  return { path, extension, type }
}

/**
 * A sha256 over an ORDERED key sequence, byte-identical to the producer's
 * `txr_zarr.key_sequence_digest`: each key is length-prefixed (u64 LE) before its UTF-8
 * bytes, then a `0xff` terminator and the count.
 *
 * Reimplemented here ON PURPOSE. The comparison in this spec is only worth something if the
 * two sides are computed independently: the declared digest comes out of the artifact row
 * the producer wrote, and this one comes out of the values the BROWSER's reader decoded
 * from the served bytes. Calling the producer's own code on both sides would agree no
 * matter what the encoder or the reader did in between.
 */
function keySequenceDigest(keys: string[]): string {
  const h = createHash('sha256')
  for (const key of keys) {
    const raw = Buffer.from(key, 'utf8')
    const prefix = Buffer.alloc(8)
    prefix.writeBigUInt64LE(BigInt(raw.length))
    h.update(prefix)
    h.update(raw)
  }
  const tail = Buffer.alloc(9)
  tail[0] = 0xff
  tail.writeBigUInt64LE(BigInt(keys.length), 1)
  h.update(tail)
  return h.digest('hex')
}

/** Decode an artifact IN THE PAGE through the shipped reader seam, dispatching on the
 *  DECLARATION exactly as production does. Returns the thrown message instead of throwing,
 *  so the negative control can assert on it. */
async function readThroughShippedReader(
  page: Page,
  artifactId: string,
  structure: unknown,
): Promise<{ columns: string[]; rows: unknown[][] } | { error: string }> {
  return page.evaluate(
    async ({ id, declared }) => {
      const seam = (
        window as unknown as {
          __txr_read?: { table: (id: string, s: unknown) => Promise<{ columns: string[]; rows: unknown[][] }> }
        }
      ).__txr_read
      if (!seam) return { error: 'no __txr_read seam on the page' }
      try {
        const table = await seam.table(id, declared)
        return { columns: table.columns, rows: table.rows }
      } catch (e) {
        return { error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }
      }
    },
    { id: artifactId, declared: structure },
  )
}

test('a real import completes through the UI and its Zarr-store artifacts read back through the shipped reader — TEST-34', async ({
  page,
  request,
}) => {
  // A real conversion plus, on a cold cache, the backend fetching + mounting its runtime
  // image. Generous, but bounded — this must finish, not hang.
  test.setTimeout(300_000)

  const token = await ownerToken(request)
  const { types, converterId } = await singleFileInputTypes(request, token)
  const fixture = smallestImportableFixture(types)

  // ── 1. upload a REAL input through the REAL upload dialog ───────────────────────────
  await loginOwnerToDatasets(page)
  const name = `import-zarr-${Date.now()}.${fixture.extension}`

  await page.getByTestId('datasets-upload-button').click()
  await expect(page.getByTestId('dataset-upload-dialog')).toBeVisible()

  // Type-first: choosing the input type is what reveals its file input. The option is
  // named by the REGISTRY's own title for the type the fixture ingests as — derived above,
  // not written here.
  await page.getByTestId('dataset-upload-type').click()
  await page.getByRole('option', { name: fixture.type.title, exact: true }).click()
  const singleInput = page.locator('[data-testid="dataset-upload-single-input"] input[type="file"]')
  await expect(
    page.getByTestId('dataset-upload-single-input'),
    `choosing "${fixture.type.title}" (${fixture.type.id}) reveals its one-file input`,
  ).toBeVisible({ timeout: 20_000 })

  await singleInput.setInputFiles([
    { name, mimeType: 'application/octet-stream', buffer: readFileSync(fixture.path) },
  ])
  await expect(page.getByTestId('dataset-upload-submit')).toBeEnabled({ timeout: 20_000 })
  await page.getByTestId('dataset-upload-submit').click()
  await expect(page.getByTestId('dataset-upload-dialog')).toBeHidden({ timeout: 60_000 })

  // The typed row exists — the datatype sniff is what enqueues the converter, so an
  // "Untyped" row here means nothing was ever going to be imported.
  //
  // Found via `findDatasetRow`, which FILTERS the library to this name first. A bare
  // page-1 lookup is not reliable under `--workers=2`: the table shows one page of 20
  // and `library.spec.ts` seeds 25 datasets in a single burst against the SAME shared
  // owner, so a concurrent run of it pushes this row onto page 2. Measured: the row
  // was "not found" here for a dataset the server had already created AND converted.
  const row = await findDatasetRow(page, name)
  await expect(row.getByTestId('dataset-datatype-badge')).not.toHaveText('Untyped')

  // ── 2. the import completes — reported by the UI, not by polling the API ────────────
  await row.getByRole('link', { name }).click()
  await expect(page.getByTestId('dataset-detail-page')).toBeVisible({ timeout: 30_000 })

  // Wait for the CONVERTER, watching the two surfaces the UI reports it on: the header
  // badge ("Ready") and the failure Alert. A hand-rolled loop rather than `expect.poll` so
  // a genuine conversion FAILURE aborts immediately, carrying the converter's own reason,
  // instead of being retried until the timeout and reported as "never became ready".
  const statusBadge = page.getByTestId('dataset-processing-status')
  const failureAlert = page.getByTestId('dataset-processing-failed')
  const deadline = Date.now() + 240_000
  let status = '(no badge rendered)'
  while (Date.now() < deadline) {
    if (await failureAlert.isVisible().catch(() => false)) {
      throw new Error(
        `the on-ingest converter "${converterId}" FAILED: ` +
          `${(await failureAlert.textContent().catch(() => '')) ?? ''} — a real import is the subject ` +
          'of this test, so a conversion failure is a failure here. It is not skippable.',
      )
    }
    status = (await statusBadge.textContent().catch(() => null)) ?? '(no badge rendered)'
    if (status === 'Ready') break
    // The row is read on navigation, so reload to observe a job that has since finished.
    await page.waitForTimeout(2_000)
    await page.reload()
    await expect(page.getByTestId('dataset-detail-page')).toBeVisible({ timeout: 30_000 })
  }
  expect(
    status,
    `the processing badge never reached "Ready" — the real import did not complete within the deadline`,
  ).toBe('Ready')

  // ── 3. what the real import emitted ─────────────────────────────────────────────────
  const dsId = new URL(page.url()).pathname.split('/').filter(Boolean).pop() as string
  expect(dsId, 'the detail URL carries the dataset id').toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  )

  const lineage = await request.get(`${BACKEND}/api/provenance/forward?dataset_id=${dsId}`, {
    headers: auth(token),
  })
  expect(lineage.ok(), `GET /provenance/forward (${lineage.status()})`).toBeTruthy()
  const outputs = ((await lineage.json()) as { outputs?: { id: string }[] }).outputs ?? []
  expect(outputs.length, 'the run recorded its outputs').toBeGreaterThan(0)

  const artifacts: ArtifactRow[] = []
  for (const o of outputs) {
    const r = await request.get(`${BACKEND}/api/artifacts/${o.id}`, { headers: auth(token) })
    expect(r.ok(), `GET /artifacts/${o.id} (${r.status()})`).toBeTruthy()
    artifacts.push((await r.json()) as ArtifactRow)
  }

  // Selected by the predicate the SERVER resolves an axis with, not by output name (INV-3).
  const axisIndexes = artifacts.filter(a => a.meta?.is_axis_index === true)
  expect(
    axisIndexes.length,
    `the import declared no axis index at all (outputs: ${artifacts.map(a => a.output_id).join(', ')}) — ` +
      `the input was imported as ${fixture.type.id}`,
  ).toBeGreaterThanOrEqual(2)

  const axisLabels = axisIndexes.map(a => String(a.structure.axis ?? ''))
  expect(new Set(axisLabels).size, `each axis index declares its own axis (got ${axisLabels.join(', ')})`).toBe(
    axisIndexes.length,
  )

  // The single-file counterpart from the SAME run. It is the negative control for the
  // "this is a directory" assertion below: without it, a 400 on the whole-artifact fetch
  // would be indistinguishable from that route simply not working.
  const singleFile = artifacts.find(a => !a.is_multifile)
  expect(
    singleFile,
    'the same import also emitted at least one SINGLE-FILE artifact — the control that makes ' +
      'the multi-file assertions below non-vacuous',
  ).toBeTruthy()

  for (const axis of axisIndexes) {
    const where = `${axis.output_id} (axis "${String(axis.structure.axis)}")`

    // ── 3a. it is a STORE, and it declares how to decode itself (ITEM-26 / ITEM-5) ────
    expect(axis.is_multifile, `${where} is a multi-file store`).toBe(true)
    expect(axis.structure.encoding, `${where} declares its encoding`).toBe('zarr_v3')
    expect(axis.structure.kind, `${where} declares its kind`).toBe('table')
    expect(axis.structure.key, `${where} names the member holding the ordered keys (INV-3)`).toBeTruthy()
    expect(String(axis.structure.key_sequence_digest ?? ''), `${where} declares a key digest`).toMatch(
      /^[0-9a-f]{64}$/,
    )
    expect(Number(axis.structure.n), `${where} declares a positive entity count`).toBeGreaterThan(1)

    // The key member is a SPLIT string column — two sub-arrays under the store. A single
    // JSON file, which is what this used to be, cannot have that shape at all.
    const columns = (axis.structure.columns ?? []) as DeclaredColumn[]
    const keyColumn = columns.find(c => (c.path ?? c.name) === axis.structure.key)
    expect(keyColumn, `${where} declares the column named by structure.key`).toBeTruthy()
    expect(keyColumn?.kind, `${where}: the key column holds strings`).toBe('string')
    expect(keyColumn?.layout, `${where}: the key column is split across members`).toBe('split')
    expect(keyColumn?.offsets, `${where}: the split column names its offsets member`).toBeTruthy()
    expect(keyColumn?.values, `${where}: the split column names its values member`).toBeTruthy()

    // ── 3b. a DIRECTORY, not a file — asserted against the served bytes ───────────────
    // Whole-artifact fetch: refused, because there is no single body to serve…
    const whole = await request.get(`${BACKEND}/api/artifacts/${axis.id}/data`, { headers: auth(token) })
    expect(whole.status(), `${where}: the store has no whole-artifact body`).toBe(400)
    // …while the very same request against the run's single-file artifact succeeds. The
    // 400 above is therefore a property of THIS artifact, not of the endpoint.
    const control = await request.get(`${BACKEND}/api/artifacts/${(singleFile as ArtifactRow).id}/data`, {
      headers: auth(token),
    })
    expect(
      control.status(),
      `the same route serves the single-file artifact "${(singleFile as ArtifactRow).output_id}" — ` +
        'so the 400 above is about the store being a directory',
    ).toBe(200)
    expect((await control.body()).byteLength, 'the control artifact has a real body').toBeGreaterThan(0)

    // …and the store's own group node carries the producer's declaration verbatim, so the
    // row and the bytes cannot drift apart.
    const groupRes = await request.get(`${BACKEND}/api/artifacts/${axis.id}/data/zarr.json`, {
      headers: auth(token),
    })
    expect(groupRes.ok(), `${where}: the store's group node is served (${groupRes.status()})`).toBeTruthy()
    const group = (await groupRes.json()) as {
      zarr_format?: number
      node_type?: string
      attributes?: { txr?: unknown }
    }
    expect(group.zarr_format, `${where} is a v3 store`).toBe(3)
    expect(group.node_type, `${where} is a group (a directory of members), not an array`).toBe('group')
    expect(group.attributes?.txr, `${where}: the store restates the row's declaration`).toEqual(axis.structure)

    // ── 4. the SHIPPED reader decodes it, in the page, over real HTTP ─────────────────
    const decoded = await readThroughShippedReader(page, axis.id, axis.structure)
    expect('error' in decoded ? decoded.error : null, `${where}: the shipped reader decoded the store`).toBeNull()
    const table = decoded as { columns: string[]; rows: unknown[][] }

    const keyIdx = table.columns.indexOf(String(axis.structure.key))
    expect(keyIdx, `${where}: the decoded table carries the declared key column`).toBeGreaterThanOrEqual(0)
    const keys = table.rows.map(r => r[keyIdx])
    expect(keys.length, `${where}: one decoded key per declared entity`).toBe(Number(axis.structure.n))
    expect(
      keys.every(k => typeof k === 'string' && k.length > 0),
      `${where}: every decoded key is a non-empty string`,
    ).toBe(true)
    const keyStrings = keys as string[]
    expect(new Set(keyStrings).size, `${where}: entity keys are unique`).toBe(keyStrings.length)

    // THE value assertion. The digest on the left is computed here from what the BROWSER
    // decoded; the one on the right was written by the producer before these bytes were
    // ever served. They can only agree if the reader recovered the producer's exact key
    // sequence, in order.
    expect(
      keySequenceDigest(keyStrings),
      `${where}: the keys the shipped reader decoded ARE the ordered sequence the producer declared`,
    ).toBe(axis.structure.key_sequence_digest)

    // Negative control (order): the same keys with two swapped must NOT digest the same,
    // or the assertion above would hold for any permutation and prove no alignment.
    const swapped = [...keyStrings]
    ;[swapped[0], swapped[1]] = [swapped[1], swapped[0]]
    expect(
      keySequenceDigest(swapped),
      `${where}: the key digest is order-sensitive (otherwise the match above is meaningless)`,
    ).not.toBe(axis.structure.key_sequence_digest)

    // Negative control (dispatch): the reader must decode on the DECLARATION, not by
    // sniffing the bytes. Handed the same store under a different declared kind it has to
    // refuse — if it sniffed, it would return the right values regardless and the decode
    // above would prove nothing about the declaration being honoured.
    const misdeclared = await readThroughShippedReader(page, axis.id, {
      ...axis.structure,
      kind: 'sparse_csc',
    })
    expect(
      'error' in misdeclared ? misdeclared.error : '(decoded anyway)',
      `${where}: the reader refuses a store whose declared kind it was not asked to read, and says which`,
    ).toMatch(/sparse_csc/)
  }
})
