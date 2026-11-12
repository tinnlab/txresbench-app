import { useMemo, useState, useSyncExternalStore } from 'react'
import { Alert, Button, Dialog, Progress, Segmented, Select, Upload, message } from '@txresbench/kit'
import { Field, FieldDescription, FieldLabel } from '@txresbench/kit/shadcn/field'
import { Datasets } from '@/modules/datasets/stores/Datasets.store'
import { matchMembers, memberRows, relativePathOf } from './memberMatch'
import { FileUp, FolderUp, X } from 'lucide-react'
import { formatBytes } from '@/modules/datasets/lib/format'
import { datatypeRegistry, type Datatype } from '@/core/datatypes'

/**
 * Type-first upload WIZARD (ITEM-12 / ITEM-14 / ITEM-16, DEC-7/9/14) — a SINGLE dialog.
 *
 * A type selector at the top offers whatever the datatype registry declares as
 * UPLOADABLE — every datatype carrying an `input_requirements` descriptor (the
 * documented "drives the upload wizard's picker" marker). Nothing here names a
 * domain datatype id: the catalog is DATA, derived from `GET /api/datatypes` (DEC-14).
 * Picking a type REVEALS exactly the file input(s) that type declares:
 *   - `single`   → one dropzone (accept globs from the type's `ingest.extensions`).
 *   - `manifest` → one named slot per declared `member`; OR (ITEM-6) ONE folder,
 *                  matched against the declaration client-side so each member shows
 *                  the relative path it bound to; OR a single `.zip`/`.tar` archive
 *                  when `allow_archive`.
 * The type's declared `axes` become the optional per-axis annotation dropzones.
 * On upload the DECLARED datatype id (+ for the manifest case the slot→filename
 * mapping) is sent with the multipart so the backend skips sniffing. The untyped
 * drop path stays on `Datasets.uploadFiles`.
 */

type ManifestMember = {
  id: string
  label: string
  accept: string
  hint: string
  /** The member as DECLARED, verbatim (`|`-alternation and path separators intact) —
   *  what `memberMatch` evaluates against a picked relative path. Everything else on
   *  this row is DERIVED from it for display; the raw string is what the rule reads. */
  declaration: string
}
type InputRequirements =
  | {
      kind: 'single'
      accept: string
      hint: string
      /** The dropzone's own prompt, DERIVED from the datatype's declared `title`.
       *  It used to name ONE file format as a literal — a hardcoded format name in the
       *  one component whose whole contract is that the catalog is DATA. */
      dropHint: string
    }
  | {
      kind: 'manifest'
      members: ManifestMember[]
      /** DEC-14 / C1: whether the declared datatype ALSO accepts a single
       *  `.zip`/`.tar` bundling `members` (`InputRequirements.allow_archive`). The
       *  archive alternative renders ONLY when this is true. */
      allowArchive: boolean
      archiveAccept: string
      archiveHint: string
    }
/** An optional per-axis annotation slot a primary type offers at upload (ITEM-16).
 *  Mirrors the datatype's declared axes (`name` + `key_label`); each becomes an
 *  optional CSV/TSV drop zone tagged `role=supporting`, `axis=name`. */
type SupportingAxis = { axis: string; label: string; hint: string }
type ConvertibleType = {
  value: string
  label: string
  requirements: InputRequirements
  supportingAxes?: SupportingAxis[]
}

/** Accept-glob string from a set of extensions (no dot in the wire): `['h5ad','zarr']`
 *  → `.h5ad,.zarr`. Empty extensions → empty accept (the browser accepts anything). */
function extAccept(extensions: string[]): string {
  return extensions.map(e => `.${e.replace(/^\./, '')}`).join(',')
}

/** Title-case + de-pluralize an axis name for a human label (`cells` → `Cell`). */
function axisSingularTitle(name: string): string {
  const singular = name.endsWith('s') ? name.slice(0, -1) : name
  return singular.charAt(0).toUpperCase() + singular.slice(1)
}

/** The filename part before the last dot (`a.bin` → `a`). */
function fileStem(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/** The filename part after the last dot, lowercased (`a.bin` → `bin`); `''` for an
 *  extension-less name. */
function fileExt(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** The last `/`- or `\`-separated part of a declared member (`a/b/c.bin` → `c.bin`);
 *  the whole string when it carries no separator. The extension globs are read off
 *  THIS, not off the raw declaration, so a dot inside a directory name cannot be
 *  mistaken for the member's own extension. */
function lastSegment(name: string): string {
  const parts = name.split(/[/\\]/).filter(p => p.length > 0)
  return parts.length > 0 ? parts[parts.length - 1] : name
}

/**
 * The slot id for a declared member's canonical spelling — the `slots` map key, the
 * React key and the `dataset-upload-slot-<id>-input` test selector, so it MUST be
 * unique across the members of one container.
 *
 * ITEM-5 (#160). It used to be the stem of the whole declaration, which is unique
 * only while every member is a bare basename. A container whose members carry their
 * own directory (the declared-depth rule, DEC-2) can and does declare the same
 * basename under three different directories — and three members sharing one id means
 * duplicate React keys, three inputs answering to one selector, and a slot map that
 * keeps the last write and silently drops two picked files.
 *
 * So a member that carries a directory is slugged from the WHOLE canonical spelling —
 * every segment INCLUDING the extension, reduced to `[a-z0-9-]`. Keeping the extension
 * matters: cutting at the last dot is what makes `bin/table.tsv` and `bin/table.csv`
 * one id, and a container whose members differ only in extension inside one directory
 * is not a hypothetical shape.
 *
 * A member with NO separator derives BYTE-IDENTICALLY to before — the branch below is
 * taken only when the declaration actually carries a directory. That is the load-
 * bearing half of this change: every shipped container declares bare basenames, so no
 * existing selector, slot-map key or gallery seed key may move, and none does.
 */
function slotId(spelling: string): string {
  const parts = spelling.split(/[/\\]/).filter(p => p.length > 0)
  // A leading or trailing separator must NOT leak into the id (and thence into a
  // `data-testid`): `/counts.h5` is one segment, and the id derives from that segment,
  // not from the raw spelling.
  if (parts.length <= 1) return fileStem(parts[0] ?? spelling).toLowerCase()
  // The DIRECTORY separator is encoded distinctly from the characters INSIDE a segment.
  // Collapsing both to one dash makes `bin/a_b.h5` and `bin/a/b.h5` the same id, which is
  // exactly the collision this function exists to prevent — one id, two React keys, two
  // inputs answering one selector.
  return parts
    .map(seg =>
      seg
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, ''),
    )
    .join('--')
}

/** Derive a manifest member slot from its declared filename (`matrix.mtx` →
 *  id `matrix`, accept `.mtx,.mtx.gz,.gz`). The member's own extension drives the
 *  accept globs — no per-format hardcoded list (DEC-14).
 *
 *  A declared member may also be a `|`-ALTERNATION of interchangeable spellings
 *  (`a.tsv|b.tsv`) — an upstream producer that renamed a file across its own
 *  versions, both of which the core accepts (`dataset/repository.rs::matches_member`
 *  splits on `|` too). The separator is WIRE syntax and must be split off BEFORE
 *  anything is derived from it. Deriving off the RAW string cut at the LAST dot —
 *  which sits inside the SECOND alternative — so the slot id KEPT the separator,
 *  which made its `dataset-upload-slot-<id>-input` testid unaddressable (and the
 *  gallery's matching seed key dead), and the field LABEL printed the raw
 *  declaration to the user. Post-split: the id is the FIRST (canonical)
 *  alternative's stem, the label spells the accepted spellings out in prose, and
 *  `accept` is the UNION over every alternative (they may differ in extension). A
 *  single-spelling member derives byte-identically to before. */
function memberSlot(member: string): ManifestMember {
  const alternatives = member
    .split('|')
    .map(a => a.trim())
    .filter(a => a.length > 0)
  // A member that is only separators still needs a slot — fall back to the raw string.
  const spellings = alternatives.length > 0 ? alternatives : [member]
  const id = slotId(spellings[0])
  const accept: string[] = []
  for (const spelling of spellings) {
    const ext = fileExt(lastSegment(spelling))
    if (!ext) continue
    for (const glob of [`.${ext}`, `.${ext}.gz`, '.gz']) {
      if (!accept.includes(glob)) accept.push(glob)
    }
  }
  return {
    id,
    label: spellings.join(' or '),
    accept: accept.join(','),
    hint: `${spellings.map(s => `${s}[.gz]`).join(' or ')}.`,
    declaration: member,
  }
}

/**
 * Make the slot ids unique WITHIN a container, by construction rather than by hope.
 *
 * `slotId` derives from a member's canonical (first) spelling, so two members sharing one
 * — `a/x.h5` and `a/x.h5|a/y.h5`, which is a declaration this system cannot group but can
 * certainly receive — derive the same id. That id is a React key, a `data-testid` segment
 * and a slot-map key, so a collision means duplicated keys, one selector answering for two
 * inputs, and a map that keeps the last write. React reports it as a console error, which
 * is how the gallery's runtime-health gate found it.
 *
 * Disambiguated by DECLARED position, so the ids are stable for any given declaration and a
 * container without collisions is byte-identical to before.
 */
function uniqueSlotIds(members: ManifestMember[]): ManifestMember[] {
  const seen = new Map<string, number>()
  return members.map(m => {
    const n = (seen.get(m.id) ?? 0) + 1
    seen.set(m.id, n)
    return n === 1 ? m : { ...m, id: `${m.id}-${n}` }
  })
}

/**
 * Derive the upload wizard's catalog from the datatype registry (DEC-14): every
 * datatype declaring `input_requirements` (the "directly uploadable" marker) becomes
 * a picker option. Label ← `title`, value ← `id`, slot shape ← `input_requirements`,
 * accept globs ← `ingest.extensions` (single) / the member filename (manifest),
 * supporting dropzones ← declared `axes`. Pure over the datatype list (unit-testable).
 */
export function deriveConvertibleTypes(types: Datatype[]): ConvertibleType[] {
  return types
    .filter(dt => dt.input_requirements != null)
    .map(dt => {
      const ir = dt.input_requirements!
      const members =
        ir.requires === 'manifest' ? uniqueSlotIds(ir.members.map(memberSlot)) : []
      const requirements: InputRequirements =
        ir.requires === 'single'
          ? {
              kind: 'single',
              accept: extAccept(dt.ingest?.extensions ?? []),
              hint: `One ${dt.title} file.`,
              dropHint: `Drop your ${dt.title} file or click to browse`,
            }
          : {
              kind: 'manifest',
              members,
              // C1 / DEC-14: carry the declared `allow_archive` through; the archive
              // alternative is offered only when the datatype permits it.
              allowArchive: ir.allow_archive,
              archiveAccept: '.zip,.tar,.tar.gz,.tgz',
              // The DERIVED member labels, never the raw declarations — otherwise a
              // `|`-alternation member prints its wire separator to the user here too.
              archiveHint: `A single .zip/.tar containing ${members.map(m => m.label).join(', ')}.`,
            }
      const supportingAxes: SupportingAxis[] = (dt.axes ?? []).map(a => ({
        axis: a.name,
        label: `${axisSingularTitle(a.name)} annotations (CSV/TSV)`,
        hint: `Optional per-${a.name.endsWith('s') ? a.name.slice(0, -1) : a.name} table keyed by ${a.key_label}.`,
      }))
      return {
        value: dt.id,
        label: dt.title,
        requirements,
        ...(supportingAxes.length > 0 ? { supportingAxes } : {}),
      }
    })
}

/** Which input a `manifest` requirement is being satisfied through (ITEM-6):
 *  the per-member slots, ONE picked folder matched against the declaration, or the
 *  single-archive alternative. */
export type InputMode = 'files' | 'folder' | 'archive'

/** Gallery-only seed for the local wizard state (real mount is zero-prop). */
export interface UploadPanelSeed {
  datatype: string
  /** Which arm of a `manifest` requirement to seed. (Was `mtxMode` — named after ONE
   *  format — then `archiveMode`, which named ONE of its own two arms; ITEM-6 adds a
   *  third, so the field is named after the choice rather than after one option.) */
  inputMode?: InputMode
  /** @deprecated the pre-ITEM-6 spelling, honoured so an out-of-tree seed keeps
   *  working; `inputMode` wins when both are given. */
  archiveMode?: 'files' | 'archive'
  single?: File | null
  slots?: Record<string, File | null>
  archive?: File | null
  /** The picked folder's entries (ITEM-6) — seeded whole so a gallery state can show
   *  the POPULATED match list without a real directory picker. */
  folderFiles?: File[]
  /** Optional per-axis annotation files, keyed by axis name (ITEM-16). */
  supporting?: Record<string, File | null>
}

/**
 * The longest part filename the server will store — `files.filename` is `varchar(255)`,
 * and the upload route refuses a longer one by name (`FILENAME_TOO_LONG`). Mirrored here
 * so the panel can refuse BEFORE the transfer, which is the reason it previews the
 * server's decision at all. CHARACTERS, not bytes, because that is what the column counts.
 */
const MAX_UPLOAD_FILENAME_CHARS = 255

/** A labeled single-file dropzone that shows the picked file with a remove button. */
function FileSlot({
  id,
  file,
  accept,
  disabled,
  dropHint,
  subHint,
  onPick,
  onRemove,
}: {
  id: string
  file: File | null
  accept: string
  disabled: boolean
  dropHint: string
  subHint?: string
  onPick: (f: File) => void
  onRemove: () => void
}) {
  if (file) {
    return (
      <div
        className="flex items-center justify-between gap-2 rounded-md bg-muted px-3 py-1.5 text-sm"
        data-testid={`${id}-file`}
      >
        <span className="truncate">{file.name}</span>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          {formatBytes(file.size)}
          {!disabled ? (
            <Button
              variant="ghost"
              size="icon"
              tooltip={`Remove ${file.name}`}
              onClick={onRemove}
              data-testid={`${id}-remove`}
            >
              <X className="size-4" />
            </Button>
          ) : null}
        </span>
      </div>
    )
  }
  return (
    <Upload
      onFiles={picked => {
        const f = picked[0]
        if (f) onPick(f)
      }}
      accept={accept}
      disabled={disabled}
      label={dropHint}
      data-testid={`${id}-input`}
    >
      <div className="flex flex-col items-center gap-1.5 text-center">
        <FileUp className="size-5 text-muted-foreground" aria-hidden />
        <span className="text-sm font-medium">{dropHint}</span>
        {subHint ? <span className="text-xs text-muted-foreground">{subHint}</span> : null}
      </div>
    </Upload>
  )
}

export function UploadPanel({ initial }: { initial?: UploadPanelSeed } = {}) {
  const { uploadOpen, uploading, uploadPct, uploadError } = Datasets
  // Subscribe to the datatype registry so the picker re-derives when the async
  // `/api/datatypes` populate replaces the bootstrap skeleton (DEC-14) — a
  // store/subscription read, NOT a bare render-time singleton read.
  const registryVersion = useSyncExternalStore(datatypeRegistry.subscribe, datatypeRegistry.getVersion)
  const convertibleTypes = useMemo(
    () => deriveConvertibleTypes(datatypeRegistry.all()),
    [registryVersion],
  )
  const [datatype, setDatatype] = useState(initial?.datatype ?? '')
  const [single, setSingle] = useState<File | null>(initial?.single ?? null)
  const [slots, setSlots] = useState<Record<string, File | null>>(initial?.slots ?? {})
  const [archive, setArchive] = useState<File | null>(initial?.archive ?? null)
  const [inputModeRaw, setInputModeRaw] = useState<InputMode | null>(
    initial?.inputMode ?? initial?.archiveMode ?? null,
  )
  const [folderFiles, setFolderFiles] = useState<File[]>(initial?.folderFiles ?? [])
  const [supporting, setSupporting] = useState<Record<string, File | null>>(initial?.supporting ?? {})

  const chosen = convertibleTypes.find(t => t.value === datatype)
  const req = chosen?.requirements

  // FIX (blind audit, high): a member that carries its own directory can NEVER be
  // satisfied by the per-member dropzones. A non-directory `<input type=file>` yields
  // `webkitRelativePath === ''`, so bare basenames go on the wire, every such member has
  // zero candidates, and the server answers 400 — with Upload enabled and nothing said
  // beforehand. For such a declaration the per-member arm is a dead end, so it is not
  // offered and Folder is the default. `deepDeclaration` is exactly the predicate the
  // core gates its one-bundle-root rule on, for the same reason: a path segment in the
  // declaration is what makes WHERE a file sits meaningful.
  const deepDeclaration =
    req?.kind === 'manifest' && req.members.some(m => /[\\/]/.test(m.declaration))
  // A `null` raw state means "not chosen yet" — the mode then FOLLOWS the declaration
  // rather than being frozen at mount, which is what a plain `useState('files')` did.
  const inputMode: InputMode =
    inputModeRaw ?? (deepDeclaration ? 'folder' : 'files')
  const setInputMode = setInputModeRaw
  /**
   * The input arms this declaration actually offers — built ONCE so that what the toggle
   * SHOWS and what it is GATED ON cannot disagree. They did: a hand-written count included
   * a Folder option that renders only for a deep declaration, so it merely MOVED the
   * unusable one-option rail from the deep case to the flat-without-archive one.
   *
   * The per-member arm is offered only where it can WORK: for a declaration carrying a
   * directory it cannot, because a non-directory picker gives the browser no relative
   * path, so every such member would arrive as a bare basename and match nothing. FOLDER
   * is offered only for a declaration that DOES carry one — for a bare-basename container
   * the per-member arm already works and is more explicit, and offering the folder arm
   * there would change the stored filenames (relative path vs basename) for data that used
   * to be uploaded one way, which moves `dataset_content_hash` (a merkle over
   * `(filename, blob)`) and so silently breaks provenance de-duplication between two
   * uploads of byte-identical data.
   */
  const inputModeOptions =
    req?.kind === 'manifest'
      ? [
          ...(deepDeclaration
            ? [{ label: 'Folder', value: 'folder' }]
            : [{ label: 'Individual files', value: 'files' }]),
          ...(req.allowArchive ? [{ label: 'Archive (.zip/.tar)', value: 'archive' }] : []),
        ]
      : []

  // ITEM-6 — the picked folder matched against the DECLARATION, client-side, by the
  // same declared-depth rule the core applies. Memoized on the picked list so a
  // re-render of a dozen rows never re-walks a tree of thousands.
  const declaredMembers = req?.kind === 'manifest' ? req.members : undefined
  const folderMatch = useMemo(
    () =>
      declaredMembers
        ? matchMembers(
            folderFiles,
            declaredMembers.map(m => ({ id: m.id, declaration: m.declaration })),
          )
        : null,
    [folderFiles, declaredMembers],
  )
  /** The members whose binding is REAL but came from the wrong bundle. Used to LABEL the
   *  row rather than blank it: a member that was found must not read "Not found". */
  const scatteredRoots = useMemo(
    () => new Set((folderMatch?.scattered ?? []).map(x => x.member)),
    [folderMatch],
  )

  const reset = () => {
    setDatatype('')
    setSingle(null)
    setSlots({})
    setArchive(null)
    setInputModeRaw(null)
    setFolderFiles([])
    setSupporting({})
  }

  const close = () => {
    if (uploading) return
    Datasets.closeUpload()
    reset()
  }

  // Switching type discards any files picked for the previous type (they can't apply).
  const pickType = (v: string) => {
    setDatatype(v)
    setSingle(null)
    setSlots({})
    setArchive(null)
    // `null` = follow the declaration: a container whose members carry a directory opens
    // on Folder, because the per-member arm cannot satisfy it (see `deepDeclaration`).
    setInputModeRaw(null)
    setFolderFiles([])
    setSupporting({})
  }

  /** The optional annotation files picked, tagged with their axis (ITEM-16). */
  const supportingParts = (chosen?.supportingAxes ?? [])
    .map(a => ({ axis: a.axis, file: supporting[a.axis] ?? null }))
    .filter((p): p is { axis: string; file: File } => p.file != null)

  // WHY the Upload cannot be pressed — computed as a SENTENCE, with `ready` derived from it
  // rather than beside it. The two used to be independent (`ready` a boolean, the reason nowhere),
  // which is how four distinct causes ended up sharing one grey button that named none of them:
  // no type picked, no file, no archive, or one/more manifest members still empty — and in the
  // last case the panel knew exactly WHICH members and threw the answer away. A dialog is the
  // worst place to withhold this: there is no surrounding page to infer the remedy from.
  const notReadyReason: string | undefined = (() => {
    if (!chosen || !req) return 'Pick a data type first'
    if (req.kind === 'single') return single != null ? undefined : 'Choose a file to upload'
    if (req.allowArchive && inputMode === 'archive') {
      return archive != null ? undefined : 'Choose an archive to upload'
    }
    // ITEM-6 — folder mode refuses BY NAME. A folder that does not bind is the common
    // case (the wrong directory, a run written without one of the declared bins), and
    // the user cannot see into a tree of thousands to work out which member is absent.
    // So every gap is spelled out: which members had no match, which had several and
    // how many, and — DEC-7 — the one browser fact that produces a wholly empty match.
    if (inputMode === 'folder') {
      if (!folderMatch || folderMatch.scanned === 0) return 'Choose a folder to upload'
      if (folderMatch.noRelativePaths) {
        // Two causes, one state: a folder DROP (no browser puts a directory's contents in
        // `dataTransfer.files`), and a picker that does not support directories at all.
        // The old copy said "use the button" — there is no button, and on a browser
        // without a directory picker the user HAD used it.
        return (
          'These files arrived without their folder structure. Click "Choose a folder" and ' +
          'select the run folder' +
          (req.allowArchive ? ', or switch to Archive and upload the bundle as one file.' : '.')
        )
      }
      // ONE sentence naming the SHAPE of the problem, not one clause per member. This
      // string is also the submit button's accessible description (the kit renders it
      // sr-only inside the button and as its tooltip), so a per-member list meant a
      // screen-reader user tabbing to Upload heard twelve clauses — and the per-member
      // detail is already on screen, in the rows.
      //
      // And it prints the DERIVED label, never the raw declaration: a member declared
      // `a.tsv|a.tsv.gz` would otherwise show the user its wire separator, which is the
      // exact leak the sibling arm's `memberSlot` exists to prevent.
      const labelOf = (declaration: string) =>
        req.members.find(m => m.declaration === declaration)?.label ?? declaration
      if (folderMatch.scattered.length > 0) {
        // Every member bound, but not inside ONE bundle — the parent-of-two-runs pick.
        // The panel must refuse here or it promises an upload the server will reject
        // after the whole transfer, which is the one thing this preview exists to avoid.
        const roots = [...new Set(folderMatch.scattered.map(x => x.root))].sort()
        return (
          `These files come from ${roots.length} different folders, so they are not one ` +
          `bundle — pick the output folder for a single run (${roots.slice(0, 2).join(', ')}` +
          `${roots.length > 2 ? ', …' : ''})`
        )
      }
      if (folderMatch.multiClaim.length > 0) {
        const c = folderMatch.multiClaim[0]
        return (
          `${folderMatch.multiClaim.length} file(s) match more than one of the declared ` +
          `files — for example ${c.name} matches ${c.members.map(labelOf).join(' and ')}`
        )
      }
      if (folderMatch.ambiguous.length > 0) {
        const n = folderMatch.ambiguous.length
        const most = Math.max(...folderMatch.ambiguous.map(a => a.candidates))
        return (
          `${n} of the declared file(s) each matched up to ${most} entries — this folder ` +
          'holds more than one run; pick a single run\'s folder (each row shows its count)'
        )
      }
      if (folderMatch.missing.length > 0) {
        const shown = folderMatch.missing.slice(0, 3).map(labelOf).join(', ')
        const more = folderMatch.missing.length - Math.min(3, folderMatch.missing.length)
        return `Still needed: ${shown}${more > 0 ? `, and ${more} more` : ''}`
      }
      // A NAME too long for the server to store is the one refusal the matcher cannot see,
      // and it is reachable exactly here: the deeper the picked folder sits, the longer
      // every member's relative path. Refusing before the transfer is the whole point of
      // this preview — otherwise the user waits out a multi-GB upload for a 400.
      const overlong = folderMatch.matched.filter(
        m => [...relativePathOf(m.file)].length > MAX_UPLOAD_FILENAME_CHARS,
      )
      if (overlong.length > 0) {
        return (
          `${overlong.length} file path(s) are longer than the ${MAX_UPLOAD_FILENAME_CHARS} ` +
          'characters the server can store — pick the run folder itself rather than a folder ' +
          'above it, or upload the bundle as an archive'
        )
      }
      // The single question the matcher answers. Anything it refuses that the branches
      // above did not name would otherwise ENABLE Upload with no reason shown.
      return folderMatch.grouped ? undefined : 'This folder cannot be uploaded as this type'
    }
    const missing = req.members.filter(m => slots[m.id] == null)
    return missing.length === 0 ? undefined : `Still needed: ${missing.map(m => m.label).join(', ')}`
  })()
  const ready = notReadyReason == null

  const submit = async () => {
    if (!chosen || !req || !ready) return
    // Optional axis-aligned annotation tables ride the same upload as supporting
    // parts (ITEM-16); the store tags them by upload-order index + axis.
    const supportingArg =
      supportingParts.length > 0 ? { supporting: supportingParts } : {}
    try {
      if (req.kind === 'single' && single) {
        await Datasets.uploadTyped({ datatype: chosen.value, files: [single], ...supportingArg })
      } else if (req.kind === 'manifest') {
        if (req.allowArchive && inputMode === 'archive' && archive) {
          await Datasets.uploadTyped({ datatype: chosen.value, files: [archive], ...supportingArg })
        } else if (inputMode === 'folder' && folderMatch) {
          // ONLY the bound entries are transferred. A real picked tree carries the run
          // summary, the per-bin sub-analyses and the expanded directory forms of the
          // same values — thousands of entries the declaration does not name and the
          // container does not retain. They are scanned, counted in the summary line,
          // and left on disk.
          const files = folderMatch.matched.map(m => m.file)
          const slotMap: Record<string, string> = {}
          for (const m of folderMatch.matched) slotMap[m.slotId] = relativePathOf(m.file)
          await Datasets.uploadTyped({ datatype: chosen.value, files, slots: slotMap, ...supportingArg })
        } else {
          const files: File[] = []
          const slotMap: Record<string, string> = {}
          for (const m of req.members) {
            const f = slots[m.id]
            if (f) {
              files.push(f)
              slotMap[m.id] = f.name
            }
          }
          await Datasets.uploadTyped({ datatype: chosen.value, files, slots: slotMap, ...supportingArg })
        }
      }
      message.success('Dataset uploaded')
      reset()
    } catch {
      /* the inline Alert (uploadError) surfaces the failure — keep the picked files */
    }
  }

  return (
    <Dialog
      open={uploadOpen}
      onOpenChange={o => {
        if (!o) close()
      }}
      title="Upload data"
      description="Pick a data type, then provide the file(s) it needs. The declared type skips detection and converts on upload."
      data-testid="dataset-upload-dialog"
      footer={
        <div className="flex justify-end gap-2">
          {/* Cancel is inert while an upload is in flight (`close()` no-ops), and used to be
              natively `disabled` — out of the tab order, silent about it, next to a progress bar
              that gives no hint the button is deliberately inert rather than broken. */}
          <Button
            variant="outline"
            onClick={close}
            unavailableReason={uploading ? 'Waiting for the upload to finish' : undefined}
            data-testid="dataset-upload-cancel"
          >
            Cancel
          </Button>
          <Button
            onClick={submit}
            loading={uploading}
            unavailableReason={notReadyReason}
            data-testid="dataset-upload-submit"
          >
            {uploading ? 'Uploading…' : 'Upload'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <Field>
          <FieldLabel htmlFor="dataset-upload-type">Data type</FieldLabel>
          <Select
            id="dataset-upload-type"
            data-testid="dataset-upload-type"
            value={datatype}
            onChange={pickType}
            placeholder="Choose a data type to convert…"
            options={convertibleTypes.map(t => ({ label: t.label, value: t.value }))}
          />
          <FieldDescription>
            Pick a type to reveal the files it needs.
          </FieldDescription>
        </Field>

        {req?.kind === 'single' ? (
          <Field data-testid="dataset-upload-single">
            <FieldLabel>File</FieldLabel>
            <FileSlot
              id="dataset-upload-single"
              file={single}
              accept={req.accept}
              disabled={uploading}
              dropHint={req.dropHint}
              subHint={req.hint}
              onPick={setSingle}
              onRemove={() => setSingle(null)}
            />
          </Field>
        ) : null}

        {req?.kind === 'manifest' ? (
          <div className="flex flex-col gap-4">
            {/* C1 / DEC-14: the ARCHIVE arm appears ONLY when the datatype declares
                `allow_archive`. ITEM-6 adds FOLDER — offered ONLY for a declaration whose
                members carry a directory, because that is the only kind the per-member arm
                cannot satisfy, and because offering it for a bare-basename container would
                let the same data be uploaded two ways with two different stored filenames
                and therefore two different content hashes (see `inputModeOptions`). */}
            {/* A ONE-option Segmented is a tab rail with a single permanently-selected
                pill that cannot be operated, so the toggle is gated on the COUNT of the
                arms actually built above — never on a hand-written re-derivation of it. */}
            {inputModeOptions.length > 1 ? (
              <Segmented
                data-testid="dataset-upload-mode"
                aria-label="Input mode"
                value={inputMode}
                onChange={v =>
                  setInputMode(v === 'archive' || v === 'folder' ? v : 'files')
                }
                options={inputModeOptions}
              />
            ) : null}

            {inputMode === 'files' && !deepDeclaration ? (
              <div className="flex flex-col gap-3" data-testid="dataset-upload-member-slots">
                {req.members.map(m => (
                  <Field key={m.id}>
                    <FieldLabel>{m.label}</FieldLabel>
                    <FileSlot
                      id={`dataset-upload-slot-${m.id}`}
                      file={slots[m.id] ?? null}
                      accept={m.accept}
                      disabled={uploading}
                      dropHint={`Drop ${m.label} here or click to browse`}
                      onPick={f => setSlots(prev => ({ ...prev, [m.id]: f }))}
                      onRemove={() => setSlots(prev => ({ ...prev, [m.id]: null }))}
                    />
                    <FieldDescription>{m.hint}</FieldDescription>
                  </Field>
                ))}
              </div>
            ) : inputMode === 'folder' ? (
              /* ITEM-6 — ONE picker, and a list bounded by the DECLARATION.
                 The picked tree is never rendered: a real bundle directory holds
                 thousands of entries, and listing them would bury the only thing the
                 user needs to check, which is that each declared member bound to the
                 path they expected. So the panel renders exactly one row per declared
                 member (a dozen at most, today), each showing either the relative path
                 it bound to or why it did not, plus ONE line for the scan total. */
              <Field data-testid="dataset-upload-folder">
                <FieldLabel>Folder</FieldLabel>
                <Upload
                  directory
                  multiple
                  onFiles={picked => setFolderFiles(picked)}
                  disabled={uploading}
                  label="Choose the folder holding this data"
                  data-testid="dataset-upload-folder-input"
                >
                  <div className="flex flex-col items-center gap-1.5 text-center">
                    <FolderUp className="size-5 text-muted-foreground" aria-hidden />
                    <span className="text-sm font-medium">Choose a folder</span>
                    <span className="text-xs text-muted-foreground">
                      Pick the output folder for ONE run — not a folder holding several.
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {req.members.length === 1 ? 'Only the 1 file' : `Only the ${req.members.length} files`}{' '}
                      this type declares{' '}
                      {folderMatch && folderMatch.scanned > 0 && !folderMatch.noRelativePaths
                        ? '(listed below) '
                        : ''}
                      {req.members.length === 1 ? 'is' : 'are'} uploaded
                      {req.allowArchive
                        ? '. To keep the whole run folder, use Archive instead.'
                        : '.'}
                    </span>
                  </div>
                </Upload>
                {folderMatch && folderMatch.scanned > 0 && !folderMatch.noRelativePaths ? (
                  <>
                    {/* `role="status"` so BOTH outcomes reach a screen reader through the
                        same channel. The warning Alert below carries `role="alert"`, so a
                        refusal was announced and a clean pick was announced by NOTHING —
                        the dropzone stays mounted and unchanged, so even the focused
                        element's name does not move. */}
                    <FieldDescription role="status" data-testid="dataset-upload-folder-summary">
                      {folderMatch.scanned} file{folderMatch.scanned === 1 ? '' : 's'} scanned,{' '}
                      {folderMatch.matched.length} of {req.members.length} member
                      {req.members.length === 1 ? '' : 's'} matched
                    </FieldDescription>
                    <div
                      className="flex flex-col gap-3"
                      data-testid="dataset-upload-folder-matches"
                    >
                      {memberRows(
                        req.members.map(m => ({ id: m.id, declaration: m.declaration })),
                        folderMatch,
                      ).map((row, i) => (
                        <div
                          key={row.slotId}
                          className="flex items-center justify-between gap-2 rounded-md bg-muted px-3 py-1.5 text-sm"
                          data-testid={`dataset-upload-folder-row-${row.slotId}`}
                        >
                          {/* `min-w-0` on BOTH: a flex child defaults to
                              `min-width:auto`, which lets a long path push the row
                              (and the dialog) wider instead of truncating — the whole
                              reason these paths are shown at all is that they are long. */}
                          <span className="min-w-0 shrink truncate">{req.members[i].label}</span>
                          <span className="sr-only">
                            {row.file
                              ? scatteredRoots.has(row.member)
                                ? ' matched, but in a different run: '
                                : ' matched to '
                              : row.candidates > 1
                                ? ' is ambiguous: '
                                : ' was not found in this folder'}
                          </span>
                          <span
                            data-testid={`dataset-upload-folder-row-${row.slotId}-path`}
                            className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground"
                          >
                            {/* A bound member says so even when the GROUP is refused. It
                                used to render "Not found" for a member that had been found,
                                because a refusal emptied the match list — the rows then
                                contradicted the alert, and the rows are what the eye lands
                                on first. */}
                            {row.file
                              ? scatteredRoots.has(row.member)
                                ? `${relativePathOf(row.file)} — different run`
                                : relativePathOf(row.file)
                              : row.candidates > 1
                                ? `${row.candidates} candidates — ambiguous`
                                : 'Not found'}
                          </span>
                        </div>
                      ))}
                    </div>
                    {notReadyReason ? (
                      <Alert
                        tone="warning"
                        title="This folder cannot be uploaded yet"
                        description={notReadyReason}
                        data-testid="dataset-upload-folder-gap"
                      />
                    ) : null}
                  </>
                ) : notReadyReason && folderMatch && folderMatch.scanned > 0 ? (
                  // Nothing carried a path, so the per-member rows would be noise: they
                  // would all read "Not found" about a scan that never really happened.
                  <Alert
                    tone="warning"
                    title="This folder cannot be uploaded yet"
                    description={notReadyReason}
                    data-testid="dataset-upload-folder-gap"
                  />
                ) : null}
              </Field>
            ) : (
              <Field data-testid="dataset-upload-archive-field">
                <FieldLabel>Archive</FieldLabel>
                <FileSlot
                  id="dataset-upload-archive"
                  file={archive}
                  accept={req.archiveAccept}
                  disabled={uploading}
                  dropHint="Drop a .zip or .tar archive or click to browse"
                  subHint={req.archiveHint}
                  onPick={setArchive}
                  onRemove={() => setArchive(null)}
                />
              </Field>
            )}
          </div>
        ) : null}

        {/* ITEM-16: optional per-axis annotation tables, one drop zone per the
            chosen type's declared axes. Folded onto the dataset as supporting
            files and integrated after the primary import. */}
        {req && chosen?.supportingAxes?.length ? (
          <div className="flex flex-col gap-3" data-testid="dataset-upload-supporting">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">Annotations (optional)</span>
              <span className="text-xs text-muted-foreground">
                Axis-aligned metadata tables integrated after import.
              </span>
            </div>
            {chosen.supportingAxes.map(a => (
              <Field key={a.axis}>
                <FieldLabel>{a.label}</FieldLabel>
                <FileSlot
                  id={`dataset-upload-supporting-${a.axis}`}
                  file={supporting[a.axis] ?? null}
                  accept=".csv,.tsv,.txt"
                  disabled={uploading}
                  dropHint={`Drop ${a.label} or click to browse`}
                  onPick={f => setSupporting(prev => ({ ...prev, [a.axis]: f }))}
                  onRemove={() => setSupporting(prev => ({ ...prev, [a.axis]: null }))}
                />
                <FieldDescription>{a.hint}</FieldDescription>
              </Field>
            ))}
          </div>
        ) : null}

        {uploading ? (
          <Progress value={uploadPct} aria-label="Upload progress" data-testid="dataset-upload-progress" showInfo />
        ) : null}

        {uploadError ? (
          <Alert
            tone="error"
            title="Upload failed"
            description={uploadError}
            data-testid="dataset-upload-error"
          />
        ) : null}
      </div>
    </Dialog>
  )
}
