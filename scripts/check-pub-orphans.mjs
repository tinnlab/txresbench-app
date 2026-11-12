#!/usr/bin/env node
/**
 * **THE ORPHAN GATE — a `pub` item in the lib crate that nothing consumes.**
 *
 * ## The hole this closes
 *
 * `dead_code` never fires on a `pub` item in a LIBRARY crate: from rustc's side, the
 * consumer is outside the crate and cannot be seen. `txresbench` is a lib + a thin binary,
 * so EVERY `pub fn` in `src/` is invisible to that lint by construction. The result is not
 * hypothetical:
 *
 * * `gather_exec::resolve_gathered_chain` — a chain walk built on a recipe shape that had
 *   been replaced, left refusing by name, called from nowhere. Found by a human reading code.
 * * `workstore::gathered_chunk_cache` — the process-wide chunk cache, with a documented
 *   ordering invariant and three unit tests, that the serve path never consulted. Found by a
 *   human reading code, for an unrelated reason. Its absence cost 123x read amplification on
 *   every gathered-column scan (`tests/workstore/gather_scale_test.rs`).
 *
 * Two in one module is a CLASS, and the third should be caught by a gate. This is it. Run on
 * the tree at `96770d83` it reports `gathered_chunk_cache`.
 *
 * ## Why an exact-match ledger and not a warning
 *
 * A lint that prints a number everyone learns to ignore is not a gate. The pinned set below
 * is matched EXACTLY: an orphan that appears fails, and an orphan that is fixed ALSO fails
 * until it is removed from the ledger. A ratchet that only tightens drifts into a list of
 * things nobody remembers were supposed to be temporary; one that fails both ways forces the
 * ledger to stay a statement about the tree.
 *
 * ## What "consumed" means here, honestly
 *
 * An identifier-occurrence count across every `.rs` file under `src-app/`, with whole-line
 * comments stripped, excluding the declaration line itself. That is a REFERENCE count, not a
 * call graph — so:
 *
 * * It cannot see a consumer outside this repo. Nothing consumes this crate as a library
 *   today; if that changes, this gate's premise changes with it.
 * * A name reachable only through a macro expansion, or only named in a non-Rust file, reads
 *   as an orphan. That is what the ledger's per-entry reason is for.
 * * A trait METHOD named identically to a free function it does not relate to reads as a
 *   consumer. This under-reports rather than over-reports, which is the failure direction a
 *   ledger can absorb: a missed orphan stays missed, it does not break the build for someone
 *   who did nothing wrong.
 *
 * * It reports the ENTRY POINT, not the whole dead subtree. `ChunkCache` itself was not
 *   flagged at 96770d83 — its three unit tests reference it — while the accessor that was
 *   its only production door, `gathered_chunk_cache`, was. That is the right resolution for a
 *   gate: one name is enough to send a reader to the cluster, and flagging a type whose tests
 *   exercise it would be a false alarm on the type.
 *
 * The alternative — a real call graph — needs `cargo` to build and a rustc plugin or
 * `rust-analyzer`; this runs in ~1s with no toolchain, which is what gets it into the default
 * gate rather than into a reader's good intentions.
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * **THE FLOOR — every `pub` item in the lib crate that is currently unconsumed.**
 *
 * Each entry states WHY it is tolerated. "It is fine" is not a reason; either the item has a
 * consumer that this counter cannot see, or it is debt with a named plan.
 */
const LEDGER = {
  // ── verified against the tree at 96770d83; each was read, not assumed ──────────────
  install_run_seams:
    'jobs/seams.rs — a "retained so existing callers/tests keep working" wrapper over ' +
    '`install_ingest_sink` + `install_recorder`. There are no such callers. Debt, and the ' +
    'kind that reads as wired: a seam installer nothing invokes leaves the Noop seam in ' +
    'place with every gate green.',
  list_references:
    'provenance/repository.rs — reference listing, written ahead of the surface meant to ' +
    'read it. Debt, pre-existing.',
  latest_verification_for_run:
    'provenance/repository.rs — same cohort as list_references. Debt, pre-existing.',
  ReferenceResourceDto:
    'provenance/models.rs — the DTO those two return. Falls with them.',
  write_generated_artifact:
    'provenance/graph.rs — writes a generated-artifact edge; no caller. Debt, pre-existing.',
  // `PENDING` (provenance/verify/mod.rs) left this ledger in #295 — WIRED, not silenced:
  // `provenance/repository.rs::insert_verification` now binds `verify::status::PENDING`
  // instead of inlining the `'pending'` SQL literal, which is what that vocabulary exists
  // for. It had also stopped being REPORTED, because `c13ffb36` added a second, consumed
  // `pub const PENDING` in `workstore/migration_repo.rs` and this counter matches
  // identifiers by NAME across the whole tree — the under-reporting direction documented
  // above. That masking class is filed as #308; it is a change to the counter's
  // derivation, not to this ledger.
  dataset_input_datatypes:
    'extensions/mod.rs — declared datatype inputs, read by no server path. Debt, pre-existing.',
  set_integration_status:
    'dataset/repository.rs — writes a dataset integration status nothing sets. Debt, ' +
    'pre-existing.',
  ensure_ready:
    'rootfs/mod.rs — the analysis rootfs readiness check. The sandbox mounts lazily on the ' +
    'first run through a different path; this one is unreached. Debt, pre-existing.',
  // `list_cached_digests` (deleted) and `gc_unreferenced` (wired) were removed from this
  // ledger by #154. The cache now has a real eviction path: `provenance::rootfs_gc`
  // supplies the referenced-digest set and drives a boot + 6-hourly sweep.
  RequireAdmin:
    'modules/permissions.rs — the root-only admin extractor. Every handler moved to ' +
    '`RequirePermissions`; the remaining mentions are prose explaining that move. Debt, ' +
    'pre-existing.',
  get_limits:
    'workstore/mod.rs — the boot-installed workstore limits accessor. The caps it returns ' +
    '(DE-page cap, slice byte cap) are read by no handler. Debt, pre-existing.',
  definition_source_ids:
    "workstore/gathered.rs — the recipe's source ids in definition-hash form. " +
    '`virtual_dataset.rs` builds the same list inline instead. Debt, pre-existing.',
  decode_row_vector:
    'workstore/gathered.rs — decodes a raw row vector. The segment model made the row plan ' +
    '`(source, row)` pairs rather than one `Vec<u32>`, so the shape this serves is gone. ' +
    'Debt, pre-existing, and the same shape as `resolve_gathered_chain`.',
};

const DECL = /^\s*pub (?:async fn|fn|struct|enum|trait|const|type) ([A-Za-z_][A-Za-z0-9_]*)/;

/** Whole-line comments carry the most identifier noise — a name in prose is not a consumer. */
const isCommentLine = (l) => /^\s*(\/\/|\/\*|\*)/.test(l);

function rsFiles(glob) {
  return execSync(`find ${glob} -name '*.rs' -not -path '*/target/*'`, {
    cwd: REPO,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean);
}

const declFiles = rsFiles('src-app/server/src');
const allFiles = rsFiles('src-app');

const decls = [];
for (const f of declFiles) {
  readFileSync(resolve(REPO, f), 'utf8')
    .split('\n')
    .forEach((line, i) => {
      const m = line.match(DECL);
      if (m) decls.push({ name: m[1], file: f, line: i + 1 });
    });
}

// Code lines only, per file, so a name mentioned solely in a doc comment does not read as use.
const code = new Map();
for (const f of allFiles) {
  code.set(
    f,
    readFileSync(resolve(REPO, f), 'utf8')
      .split('\n')
      .map((l) => (isCommentLine(l) ? '' : l)),
  );
}

const orphans = [];
for (const d of decls) {
  const re = new RegExp(`\\b${d.name}\\b`, 'g');
  let refs = 0;
  for (const [f, lines] of code) {
    lines.forEach((l, i) => {
      if (f === d.file && i + 1 === d.line) return; // the declaration is not a consumer
      const m = l.match(re);
      if (m) refs += m.length;
    });
  }
  if (refs === 0) orphans.push(d);
}

const found = new Set(orphans.map((o) => o.name));
const pinned = new Set(Object.keys(LEDGER));
const added = orphans.filter((o) => !pinned.has(o.name));
const fixed = [...pinned].filter((n) => !found.has(n));

console.log(
  `check-pub-orphans: ${decls.length} pub item(s) in the lib crate, ` +
    `${orphans.length} with no consumer (ledger pins ${pinned.size}).`,
);

let failed = false;
if (added.length) {
  failed = true;
  console.error('\nNEW ORPHAN(S) — a `pub` item nothing consumes:\n');
  for (const o of added) console.error(`  ${o.file}:${o.line}  ${o.name}`);
  console.error(
    '\n`dead_code` cannot see this: the item is `pub` in a LIBRARY crate, so rustc assumes a\n' +
      'consumer outside it. Two items already reached `main` that way. Either WIRE it (that is\n' +
      'what the item was for) or DELETE it with its tests and its doc — and if it genuinely has\n' +
      'a consumer this counter cannot see, add it to LEDGER in this file WITH that reason.\n',
  );
}
if (fixed.length) {
  failed = true;
  console.error('\nSTALE LEDGER ENTR(Y/IES) — pinned as an orphan but now consumed:\n');
  for (const n of fixed) console.error(`  ${n}`);
  console.error(
    '\nThe ledger is a statement about the tree, not a permanent allowance. Remove the entry\n' +
      'so the floor drops and cannot be silently re-spent.\n',
  );
}

if (failed) process.exit(1);
console.log('check-pub-orphans: OK — the orphan set is exactly the pinned floor.');
