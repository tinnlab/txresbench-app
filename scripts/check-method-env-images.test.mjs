#!/usr/bin/env node
// check-method-env-images.test.mjs — the negative controls for
// `scripts/check-method-env-images.sh` (plan node method-env-images, ITEM-4).
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────
// The manifest is generated (INV-5) and the runtime consumes it verbatim
// (digest-pinned fetch, `size_bytes` shown before the download, saved-model
// provenance). The guard that says the committed file is valid has to be shown
// refusing the invalid shapes, or it is another opinion in a header comment. So
// every assertion below DRIVES THE REAL GUARD as a subprocess over a fixture
// manifest and reads the child's OWN exit status — never a status observed
// through a pipe.
//
// The fixtures are synthetic (generated ids, fake-but-well-formed hashes); the
// GUARD and the GENERATOR are the real, byte-for-byte repo files. The manifest
// texts are produced by the generator's own `--fixture` mode, so the schema and
// the writer agree on what a VALID entry is before a mutation is applied.
//
// ── NO DOMAIN ID AND NO REAL METHOD ID IS SPELLED ──────────────────────────────
// This file lives under `scripts/`, which the derived-vocabulary guard scans;
// the fixture ids are generated (`fixture-a`/`fixture-b`), so a guard that had
// quietly hard-coded a method would score zero here.
//
// Coverage map (TESTS.md):
//   TEST-1   schema/structural refusals (duplicate, missing size, digest shape,
//            uppercase env id, arch set, placeholder text, sorted order,
//            unknown field, env_id != method_id) + licence-as-data
//   TEST-2   regen parity: fixture byte-parity green, then red naming the first
//            differing key after a manual edit / a bumped revision; the guard's
//            parity leg (skip-with-reason, live run, --require-parity)
//   TEST-5   the guard passes the committed manifest; the network-allowlist
//            guard is unaffected (no allowlist edit; DEC-17) + the publisher's
//            --dry-run names only the allowlisted host ghcr.io
//   TEST-6   both files pinned in scripts/guard-hashes.txt; an unpinned
//            guard-shaped file fails check 2 of check-guard-integrity.sh
//   TEST-9   the publisher: cross-arch refusal (ALLOW_EMULATED_BUILD gate),
//            credentials requirement (or --dry-run), overwrite refusal when
//            the remote tag names different bytes, and the full stubbed
//            sequence (resolve → base resolve → blob/manifest push → resolve
//            → sign; no `oras login`, every oras call carrying the temporary
//            mode-600 registry config) — each driven against a stub
//            `oras`/`cosign` on PATH, never a network.
//   TEST-10  the full-generation manifest: one entry per runnable method per
//            published arch (amd64 + arm64 under one env id), no duplicate
//            (env_id, arch), per-arch tags `^<version>-<arch>$`, deterministic
//            order, the guard accepting it, and a non-runnable record refused
//   TEST-11  every entry carries the non-empty identity + provenance triplet
//            and the licence VERBATIM from method.json; a licence change is a
//            regeneration event, never an edit
//   TEST-8   the behavioral verifier (scripts/lib/method-env-verify.sh):
//            green on a REAL squashfs layer, then each contract violation
//            (absent layer.squashfs, sha256 mismatch, no /code/run.py) refuses
//            with a named cause, and the publisher refuses to push on that
//            failure — the artifact-level checks read the built bytes and
//            therefore need REAL mksquashfs/unsquashfs (the layer fixtures).
//   TEST-13  the base artifacts: the writer emits `bases` and stages each
//            base's exact OCI manifest bytes; it refuses an entry without
//            its staged base, a base packed from another image (naming both
//            digests) and a stray dir under bases/; parity covers `bases`;
//            the guard refuses every broken `bases` rule and checks a
//            manifest without `bases` as before; the generator's base pack
//            is deterministic and refuses a rootfs without what the stacked
//            run needs; --stage-bases never builds and stages only from the
//            image with the recorded digest (a stub `docker`, no daemon).
//   TEST-14  the publisher's bases: `--base` publishes a base with the same
//            byte checks, guard, overwrite refusal, verbatim push, resolve
//            witness and signing as a layer, plus a listing check of what the
//            stacked run needs; a layer publish refuses until its base is
//            published and refuses a manifest without `bases`; `--registry`
//            accepts only 127.0.0.1:<port> / [::1]:<port>, and then every
//            oras call is plain HTTP to that host through the anonymous {}
//            config with no login and no cosign (stub oras/cosign, no
//            network).
//   TEST-15  one package for every layer and one for both bases: the writer
//            emits `oci_ref` = the package and the env (base) in the tag, a
//            layer tag ending with the first 12 hex of its layer_sha256;
//            records staged before 0.4.0 (one package per method / base)
//            assemble to the SAME manifest bytes and are published at the
//            new address, and a record with any other address (the
//            one-package tag without the hash included) is refused; the
//            guard refuses the old addresses, a tag of another entry, a tag
//            without or with another hash, an over-long tag and two entries
//            sharing a tag; the publisher refuses an entry or base that is not
//            in the one-package form, an entry tag hash among them.
//   TEST-12  the layer cover (`closed_cover`) on small base/method trees: a
//            method's Python and R packages under /opt/txr-layer are the ONE
//            entry /opt/txr-layer (beside /code), including a package the base
//            also has; a new package dir in the base's own library and a new
//            /opt folder are refused at build time, naming the path (the base's
//            /usr and /opt are read-only in the sandbox, so no mount point could
//            be made for them); a changed file the base already has stays an
//            entry; a code-only method is just /code.
//   TEST-16  one method's build input (generator 0.5.0): a dirty, untracked or
//            ungated method folder is refused before any docker call; the facts
//            come from method.json + the Dockerfile at HEAD (a stale index.json
//            is never read); the build context is the committed folder (git
//            archive); a pinned build uses the local base image at the pinned
//            digest (tagging it by digest), refuses when it is not on the
//            machine (never pulls, never rebuilds) and when the tag moved
//            during the build; the base flags are exclusive.
//   TEST-17  lists one method at a time (schema 2): records at different
//            commits and pre-0.5.0 records assemble into one list, each entry
//            with its own commit, folder tree and generator; every provenance
//            refusal (version, folder in no commit, unknown commit, tree,
//            wrapper, FROM, language) names the record; `--previous` carries
//            the other entries byte for byte, refuses a schema 1 / no-bases
//            previous, another base image, another contract, an unknown drop;
//            a base change is a batch (`--replace-base`, `--drop`), a new base
//            file from the same image keeps every layer; `--only` at assembly.
//   TEST-18  parity entry by entry: against the previous list (carried
//            byte-identical, the rest re-assembled; edited carried entries,
//            missing records, edited bases and a non-writer serialization
//            fail), and for named entries / bases only.
//   TEST-19  provenance: every entry's facts at its own commit (the three
//            AUDIT P7 shapes and the rest, all reported in one run); the
//            guard's provenance leg, its skip and --require-provenance; the
//            guard's parity modes.
//   TEST-20  the schema 2 shape in the guard: per-entry provenance required and
//            well formed, no top-level source_revision, no `+` in a version.
//   TEST-21  the publisher checks the entry it publishes (narrowed on purpose,
//            2026-11-16): one method publishes from a dir holding only its
//            record, against the previous list; the whole-list mode refuses
//            it; a record whose provenance is not the entry's is refused; a
//            pre-0.5.0 record is accepted and said so; --methods-dir required.
//
//   TEST-22  reproducible layers (generator 0.6.0, FOLLOW-UPS 64): one layer
//            root packs to the same bytes every time; the layer's OCI manifest
//            names the layer and its file only (no methods commit, no base
//            image), so the same file rebuilt at a later commit or over a new
//            base image keeps its digest and tag.
//
//   TEST-23  the trim (design §4, generator 0.6.1): TensorFlow's packages that
//            `import tensorflow` loads although they are named docs or test
//            (tensorflow/tools/docs, the test modules under tensorflow/_api)
//            are kept, without their bytecode; every other trim-named dir is
//            still removed, Python packages named test or docs (joblib/test)
//            included; the delta trim and the layer trim keep the same files.
//   TEST-24  -processors on every mksquashfs pack: the helper is
//            len(os.sched_getaffinity(0)); the layer and base pack command
//            lines carry `-processors <that>` AFTER the flags (mock _run); the
//            flag constants never hold `-processors`; and a small fixture
//            packed with -processors 1 vs 4 is byte-identical (real
//            mksquashfs, LAYER_MKSQUASHFS_FLAGS).
//
//   node --test scripts/check-method-env-images.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SCRIPTS_DIR, '..');
const GUARD = path.join(SCRIPTS_DIR, 'check-method-env-images.sh');
const GENERATOR = path.join(SCRIPTS_DIR, 'generate-method-env-images.py');
const PUBLISHER = path.join(SCRIPTS_DIR, 'publish-method-env-images.sh');
const COMMITTED_MANIFEST = path.join(REPO, 'src-app/server/data/method-env-images.json');
// The ONE package of every layer and the ONE package of both bases (the env
// or base is in the tag), spelled independently of the generator.
const LAYER_PACKAGE = 'ghcr.io/tinnlab/txr-method-env-layers';
const BASE_PACKAGE = 'ghcr.io/tinnlab/txresbench-env';

const TMPROOT = process.env.TMPDIR || os.tmpdir();
const tmpDirs = [];
function mkdtemp(prefix) {
  const d = fs.mkdtempSync(path.join(TMPROOT, prefix));
  tmpDirs.push(d);
  return d;
}
process.on('exit', () => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function guard(args = [], env = {}) {
  return spawnSync('bash', [GUARD, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function gen(args = []) {
  return spawnSync('python3', [GENERATOR, ...args], {
    cwd: REPO,
    encoding: 'utf8',
  });
}

// ── fixtures ──────────────────────────────────────────────────────────────────
// A fixture methods REPOSITORY (a real git repo: method folders + gates/,
// committed) + staged artifact records, written by hand in the exact
// `artifact.json` shape the build produces, then a manifest produced by the
// generator's own `--fixture` (assemble-only) mode. The writer reads every
// method fact from git at each record's own commit, so the fixture records
// carry that commit and the folder's git tree, like a real build.
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@txr.test',
  GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@txr.test',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};

function git(dir, args) {
  const r = spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8', env: { ...process.env, ...GIT_ENV },
  });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** The host arch, for the generator's native-arch build gate. */
const HOST_ARCH = process.arch === 'arm64' ? 'arm64' : 'amd64';

const RECORD_A = {
  record_schema_version: 2,
  generator_version: '0.5.0',
  env_id: 'fixture-a',
  method_id: 'fixture-a',
  method_version: '2.0.0',
  language: 'Python',
  arch: 'amd64',
  oci_ref: LAYER_PACKAGE,
  // tag: `<env_id>-<version>-<arch>-<sha12>`, set by stagedLayerRecord from
  // the real layer bytes (like layer_sha256); source_revision and
  // source_tree are the fixture commit's (set from the methods repo).
  base_ref: 'ghcr.io/tinnlab/txresbench-base-py:2.0',
  base_digest: 'sha256:' + 'ab'.repeat(32),
  base_digest_source: 'repo_digests',
  base_ref_source: 'local',
  built_image_tag: 'txr-env-build:fixture-a-amd64',
  layer_file: 'layer.squashfs',
  layer_sha256: '57b6c5316aa39e240910092ff6eab587e56196b579d1593a990e6cde6f725cae',
  size_bytes: 4096,
  wrapper_code_sha256: 'a8b34e57dd8059cbf3fffb044e9dde4e914464b4dfb190cf0f9e4528d5e056d0',
  layer_schema: 1,
  layer_manifest: ['/code'],
  run_file: 'run.py',
  delta: { added: 2, changed: 0, removed_refused: 0,
           dropped_excluded_tops_added: 0, dropped_excluded_tops_deleted: 0 },
};
const RECORD_B = {
  ...RECORD_A,
  env_id: 'fixture-b',
  method_id: 'fixture-b',
  language: 'R',
  base_ref: 'ghcr.io/tinnlab/txresbench-base-r:2.0',
  layer_sha256: 'a07cd921df4d1ed80a6d0190210cedbfc4d6e09aaf433947b28e3f8f972057ea',
  wrapper_code_sha256: 'be460acb0ede00fcef1f12b19d837048ab4648d0d6f2920677be2b667a4233fb',
  run_file: 'run.R',
};

/** The bytes of a fixture method's method.json and wrapper: the methods
 *  repository and the layer's /code carry the SAME bytes (the wrapper hash
 *  the writer re-derives from git must be the record's). */
function methodJsonText({ id, licence, language, version }) {
  return JSON.stringify({ id, version, licence, language });
}
function runText(run, extra = '') {
  return `#!/usr/bin/env ${run === 'run.py' ? 'python3' : 'Rscript'}\n# fixture wrapper\n${extra}`;
}

/** A method folder in the fixture methods repo: method.json, its wrapper,
 *  a Dockerfile FROM its language's base, and gates/<id>.json (`gate`:
 *  true = passed, false = failed, null = no gate file). */
function writeMethodFolder(methodsDir, { id, licence, language, version, run,
  gate = true, contract = '2.0', runExtra = '' }) {
  const d = path.join(methodsDir, 'methods', id);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'method.json'), methodJsonText({ id, licence, language, version }));
  fs.writeFileSync(path.join(d, run), runText(run, runExtra));
  const family = language === 'R' ? 'r' : 'py';
  fs.writeFileSync(path.join(d, 'Dockerfile'),
    `FROM ghcr.io/tinnlab/txresbench-base-${family}:${contract}\nCOPY method.json ${run} /code/\n`);
  fs.mkdirSync(path.join(methodsDir, 'gates'), { recursive: true });
  const gatePath = path.join(methodsDir, 'gates', `${id}.json`);
  if (gate === null) fs.rmSync(gatePath, { force: true });
  else fs.writeFileSync(gatePath, JSON.stringify({ pass: gate }));
}

/** Commit everything in the fixture methods repo; returns the full commit. */
function commitAll(methodsDir, msg) {
  if (!fs.existsSync(path.join(methodsDir, '.git'))) git(methodsDir, ['init', '-q']);
  git(methodsDir, ['add', '-A']);
  git(methodsDir, ['commit', '-q', '--allow-empty', '-m', msg]);
  return git(methodsDir, ['rev-parse', 'HEAD']);
}

/** The provenance a record built at `commit` carries. */
function provenance(methodsDir, commit, id) {
  return { source_revision: commit.slice(0, 12),
           source_tree: git(methodsDir, ['rev-parse', `${commit}:methods/${id}`]) };
}

/** The staged layer.squashfs is a REAL squashfs (mksquashfs over a fixture
 *  layer root carrying the schema marker, /code payload and the bind
 *  manifest), and the record's `layer_sha256`/`size_bytes`/`wrapper_code_sha256`
 *  are set to THEIR REAL values — the publisher (ITEM-5) re-hashes the
 *  staged file and ITEM-7's behavioral verifier EXTRACTS it, so the fixture
 *  byte contract must be truthful for the publisher / verifier to be the
 *  thing under test. */
function writeLayerRoot(root, { id, licence, run, language, version, withRun = true, runExtra = '' }) {
  fs.mkdirSync(path.join(root, 'code'), { recursive: true });
  fs.writeFileSync(path.join(root, 'code', 'method.json'),
    methodJsonText({ id, licence, language, version }));
  if (withRun) {
    fs.writeFileSync(path.join(root, 'code', run), runText(run, runExtra));
  }
  fs.writeFileSync(path.join(root, '.txr-method-env-layer-schema'), '1');
  fs.writeFileSync(path.join(root, 'layer-manifest.json'), JSON.stringify(['/code']));
  // The root-level usr/ sentinel (design §5): the runtime's shared mount
  // readiness probe is `usr/ present == mounted` for every artifact; the
  // generator emits it, and the fixture layers must carry it too.
  fs.mkdirSync(path.join(root, 'usr'));
}

/** mksquashfs a fixture layer root (the ARTIFACT shape, host tool). The
 *  -processors value rides the fixture command line the way the generator
 *  passes it: the CPUs this process may use. */
function squashLayer(root, out) {
  const r = spawnSync('mksquashfs', [
    root, out, '-comp', 'zstd', '-b', '1M', '-noappend', '-no-progress', '-all-root',
    '-processors', String(os.availableParallelism()),
  ], { encoding: 'utf8' });
  assert.equal(r.status, 0, `mksquashfs failed: ${r.stderr}\n${r.stdout}`);
}

/** sha256(method.json bytes ‖ run-file bytes) — the design §2.2 convention the
 *  record must carry and the ITEM-7 verifier re-derives from the layer. */
function wrapperSha(root, run) {
  const mj = fs.readFileSync(path.join(root, 'code', 'method.json'));
  const rf = fs.readFileSync(path.join(root, 'code', run));
  return createHash('sha256').update(Buffer.concat([mj, rf])).digest('hex');
}

function stagedLayerRecord(dir, rec, root, run, { withRun = true } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const squashfs = path.join(dir, 'layer.squashfs');
  squashLayer(root, squashfs);
  const bytes = fs.readFileSync(squashfs);
  // The wrapper hash is design §2.2's convention over the layer's own payload;
  // a wrapper-less layer (TEST-8's broken artifact) honestly hashes only the
  // bytes it carries — the verifier refuses it at the run-file check before
  // this field could matter.
  const wrapper = withRun
    ? wrapperSha(root, run)
    : createHash('sha256').update(fs.readFileSync(path.join(root, 'code', 'method.json'))).digest('hex');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const record = {
    ...rec,
    tag: `${rec.env_id}-${rec.method_version}-${rec.arch}-${sha.slice(0, 12)}`,
    layer_sha256: sha,
    size_bytes: bytes.length,
    wrapper_code_sha256: wrapper,
  };
  fs.writeFileSync(path.join(dir, 'artifact.json'), JSON.stringify(record, null, 2));
  return record;
}

/** Stage one method's layer the way a build at `commit` would: a layer root
 *  whose /code is the committed method.json + wrapper, packed for real, and
 *  its record with that commit's provenance. */
function stageMethodLayer(base, staging, methodsDir, commit, spec, rec, { withRun = true } = {}) {
  const arch = rec.arch || 'amd64';
  const root = path.join(base, `${spec.id}-${arch}-${commit.slice(0, 7)}-root-${Math.random().toString(36).slice(2, 8)}`);
  writeLayerRoot(root, { ...spec, withRun });
  return stagedLayerRecord(path.join(staging, 'layers', `${spec.id}-${arch}`),
    { ...rec, ...provenance(methodsDir, commit, spec.id) }, root, spec.run, { withRun });
}

/** The first 12 hex of a staged layer file's sha256, read from the bytes. */
function layerSha12(staging, dirName) {
  const bytes = fs.readFileSync(path.join(staging, 'layers', dirName, 'layer.squashfs'));
  return createHash('sha256').update(bytes).digest('hex').slice(0, 12);
}

// ── staged base fixtures (design §6.3) ───────────────────────────────────────
// The fixture layers' base image (RECORD_A/B's base_ref + base_digest); each
// staged base record pairs with it, as the generator's own staging does.
const BASE_SOURCE = {
  'base-py': 'ghcr.io/tinnlab/txresbench-base-py:2.0',
  'base-r': 'ghcr.io/tinnlab/txresbench-base-r:2.0',
};
const BASE_SOURCE_DIGEST = RECORD_A.base_digest;
const BASE_FIELDS = ['base_id', 'arch', 'oci_ref', 'tag', 'digest', 'squashfs_sha256',
  'size_bytes', 'source_ref', 'source_digest', 'contract'];
const ENV_FIELDS = ['env_id', 'method_id', 'method_version', 'language', 'arch', 'oci_ref',
  'tag', 'digest', 'layer_sha256', 'size_bytes', 'base_ref', 'base_digest', 'contract',
  'licence', 'wrapper_code_sha256', 'layer_schema', 'source_revision', 'source_tree',
  'generator_version'];

/** A tiny base root holding what the stacked run needs: the layer mount
 *  point (+ the R library for base-r), /usr/bin/prlimit and /usr/bin/bash,
 *  plus the Debian `bin -> usr/bin` link. `omit` drops paths; `binLink: null`
 *  leaves the base without its own /bin (the sandbox makes /bin itself). */
function writeBaseRoot(root, baseId, { omit = [], binLink = 'usr/bin', extra = {} } = {}) {
  const files = {
    'opt/txr-layer/': null,
    'usr/bin/prlimit': '#!/bin/sh\n',
    'usr/bin/bash': '#!/bin/sh\n',
    ...extra,
  };
  if (baseId === 'base-r') files['opt/txr-layer/R-library/'] = null;
  for (const rel of omit) delete files[rel];
  writeTree(root, files);
  fs.mkdirSync(path.join(root, 'usr', 'bin'), { recursive: true });
  if (binLink !== null) fs.symlinkSync(binLink, path.join(root, 'bin'));
}

/** Stage one base the way the generator does: a REAL base.squashfs and a
 *  record whose hash/size/tag are the file's own. */
function stagedBaseRecord(staging, baseId, arch, root, overrides = {}) {
  const dir = path.join(staging, 'bases', `${baseId}-${arch}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'base.squashfs');
  squashLayer(root, file);
  const bytes = fs.readFileSync(file);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const rec = {
    record_schema_version: 1,
    kind: 'base',
    generator_version: '0.3.0',
    base_id: baseId,
    arch,
    contract: '2.0',
    oci_ref: BASE_PACKAGE,
    tag: `${baseId}-2.0-${arch}-${sha.slice(0, 12)}`,
    base_file: 'base.squashfs',
    squashfs_sha256: sha,
    size_bytes: bytes.length,
    source_ref: BASE_SOURCE[baseId],
    source_digest: BASE_SOURCE_DIGEST,
    source_ref_source: 'local',
    source_digest_source: 'repo_digests',
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, 'artifact.json'), JSON.stringify(rec, null, 2));
  return { dir, rec };
}

function stageFixtureBase(base, staging, baseId, arch, overrides = {}, rootOpts = {}) {
  const root = path.join(base, `${baseId}-${arch}-root-${Math.random().toString(36).slice(2, 8)}`);
  writeBaseRoot(root, baseId, rootOpts);
  return stagedBaseRecord(staging, baseId, arch, root, overrides);
}

const SPEC_A = { id: 'fixture-a', licence: 'verbatim-licence-of-fixture-a-LLC', language: 'Python',
  version: '2.0.0', run: 'run.py' };
const SPEC_B = { id: 'fixture-b', licence: 'verbatim-licence-of-fixture-b-LLC', language: 'R',
  version: '2.0.0', run: 'run.R' };
// A method in the repository that never passed its gate: it gets no layer.
const SPEC_C = { id: 'fixture-c', licence: 'verbatim-licence-of-fixture-c-LLC', language: 'Python',
  version: '1.0.0', run: 'run.py', gate: false };

/** The fixture methods repository (fixture-a/b gated, fixture-c not) at its
 *  first commit; returns that commit. */
function fixtureMethodsRepo(methodsDir) {
  for (const spec of [SPEC_A, SPEC_B, SPEC_C]) writeMethodFolder(methodsDir, spec);
  fs.writeFileSync(path.join(methodsDir, '.gitignore'), '__pycache__/\n*.pyc\nindex.json\n');
  return commitAll(methodsDir, 'fixture methods');
}

/** methodsDir (a git repo) + stagingDir with two staged records built at its
 *  first commit; the manifest is written by the real generator's --fixture
 *  --full mode and returned as its path. */
function fixture() {
  const base = mkdtemp('mei-fixture-');
  const methodsDir = path.join(base, 'methods');
  const staging = path.join(base, 'staged');
  const manifestPath = path.join(base, 'manifest.json');
  const commit = fixtureMethodsRepo(methodsDir);
  stageMethodLayer(base, staging, methodsDir, commit, SPEC_A, RECORD_A);
  stageMethodLayer(base, staging, methodsDir, commit, SPEC_B, RECORD_B);
  // The bases the two amd64 layers stack on (fixture-a Python, fixture-b R).
  stageFixtureBase(base, staging, 'base-py', 'amd64');
  stageFixtureBase(base, staging, 'base-r', 'amd64');
  const r = gen(['--fixture', staging, '--methods-dir', methodsDir, '--manifest', manifestPath, '--full']);
  assert.equal(r.status, 0, `fixture manifest did not assemble: ${r.stderr}`);
  return { base, methodsDir, staging, manifestPath, commit };
}

// ── ITEM-6 fixture: the FULL-GENERATION shape ─────────────────────────────────
// TEST-10/TEST-11 pin the GENERATED-MANIFEST properties on the fixture repo:
// one entry per gated method per published arch (here a native arm64 record
// of a method added in a SECOND commit: one list holds entries built at
// different commits), per-arch tags
// `^<env_id>-<version>-(amd64|arm64)-<sha12>$`, and the full provenance
// triplet + the verbatim licence (INV-6/TEST-11).
const RECORD_D = {
  ...RECORD_A,
  env_id: 'fixture-d',
  method_id: 'fixture-d',
  method_version: '1.5.0',
  arch: 'arm64',
  wrapper_code_sha256: 'c4f0c7861fd6f6d66b2a90c8e35fc787a49e85bfef2c35d7b7270fd5c89cda25',
};
const SPEC_D = { id: 'fixture-d', licence: 'verbatim-licence-of-fixture-d-LLC', language: 'Python',
  version: '1.5.0', run: 'run.py' };

/** The ITEM-6 fixture: three staged records (a amd64 and b amd64 at the first
 *  commit, d arm64 at a second commit that added fixture-d) over a repo with
 *  one non-gated method (fixture-c); the manifest is written by the real
 *  generator. */
function fixtureFull() {
  const fx = fixture();
  const manifestPath = path.join(fx.base, 'manifest-full.json');
  writeMethodFolder(fx.methodsDir, SPEC_D);
  const commit2 = commitAll(fx.methodsDir, 'add fixture-d');
  stageMethodLayer(fx.base, fx.staging, fx.methodsDir, commit2, SPEC_D, RECORD_D);
  stageFixtureBase(fx.base, fx.staging, 'base-py', 'arm64');
  const r = gen(['--fixture', fx.staging, '--methods-dir', fx.methodsDir, '--manifest', manifestPath, '--full']);
  assert.equal(r.status, 0, `ITEM-6 fixture manifest did not assemble: ${r.stderr}`);
  return { ...fx, manifestPath, commit2 };
}

function withMutated(manifestPath, fn) {
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  fn(m);
  const p = path.join(path.dirname(manifestPath), `mutated-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify(m, null, 2) + '\n');
  return p;
}

// ── the guard over the committed manifest ─────────────────────────────────────
test('TEST-1 the committed manifest validates and the guard accepts it', () => {
  const r = guard();
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.match(r.stdout + r.stderr, /OK/);
});

// ── TEST-1 refusals over the fixture manifest ────────────────────────────────
test('TEST-1a the guard accepts a well-formed fixture manifest', () => {
  const { manifestPath } = fixture();
  const r = guard(['--manifest', manifestPath]);
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.match(r.stdout + r.stderr, /OK — 2 env entries/);
});

test('TEST-1b a duplicate (env_id, arch) is refused', () => {
  const { manifestPath } = fixture();
  const p = withMutated(manifestPath, (m) => {
    const copy = { ...m.envs[0], size_bytes: 8192 };
    m.envs.push(copy);
  });
  const r = guard(['--manifest', p]);
  assert.equal(r.status, 1, 'duplicate (env_id, arch) must be refused');
  assert.match(r.stderr, /duplicate \(env_id, arch\)/);
  assert.match(r.stderr, /fixture-a/);
});

test('TEST-1c a missing size_bytes is refused', () => {
  const { manifestPath } = fixture();
  const p = withMutated(manifestPath, (m) => { delete m.envs[0].size_bytes; });
  const r = guard(['--manifest', p]);
  assert.equal(r.status, 1, 'missing size_bytes must be refused');
  assert.match(r.stderr, /size_bytes/);
});

test('TEST-1d a non-sha256 digest is refused', () => {
  const { manifestPath } = fixture();
  const p = withMutated(manifestPath, (m) => { m.envs[0].digest = 'md5:0123456789abcdef0123456789abcdef'; });
  const r = guard(['--manifest', p]);
  assert.equal(r.status, 1, 'a non-sha256 digest must be refused');
  assert.match(r.stderr, /digest/);
  assert.match(r.stderr, /sha256/);
});

test('TEST-1e an uppercase env_id is refused', () => {
  const { manifestPath } = fixture();
  const p = withMutated(manifestPath, (m) => { m.envs[0].env_id = 'Fixture-A'; });
  const r = guard(['--manifest', p]);
  assert.equal(r.status, 1, 'an uppercase env_id must be refused');
  assert.match(r.stderr, /env_id/);
});

test('TEST-1f an out-of-set arch is refused', () => {
  const { manifestPath } = fixture();
  const p = withMutated(manifestPath, (m) => { m.envs[0].arch = 'x86'; });
  const r = guard(['--manifest', p]);
  assert.equal(r.status, 1, 'an out-of-set arch must be refused');
  assert.match(r.stderr, /arch/);
  assert.match(r.stderr, /amd64/);
});

test('TEST-1g placeholder text is refused and named', () => {
  const { manifestPath } = fixture();
  const p = withMutated(manifestPath, (m) => { m.envs[0].method_version = '2.0.0-TODO'; });
  const r = guard(['--manifest', p]);
  assert.equal(r.status, 1, 'placeholder text must be refused');
  assert.match(r.stderr, /placeholder/i);
  assert.match(r.stderr, /TODO/);
});

test('TEST-1h unsorted entries are refused', () => {
  const { manifestPath } = fixture();
  const p = withMutated(manifestPath, (m) => { m.envs = [m.envs[1], m.envs[0]]; });
  const r = guard(['--manifest', p]);
  assert.equal(r.status, 1, 'unsorted entries must be refused');
  assert.match(r.stderr, /sorted/);
});

test('TEST-1i an unknown field is refused (schema additionalProperties)', () => {
  const { manifestPath } = fixture();
  const p = withMutated(manifestPath, (m) => { m.envs[0].extra = 1; });
  const r = guard(['--manifest', p]);
  assert.equal(r.status, 1, 'an unknown field must be refused');
  assert.match(r.stderr, /additional property/);
});

test('TEST-1j env_id != method_id is refused (DEC-1)', () => {
  const { manifestPath } = fixture();
  const p = withMutated(manifestPath, (m) => { m.envs[0].method_id = 'other-id'; });
  const r = guard(['--manifest', p]);
  assert.equal(r.status, 1, 'env_id != method_id must be refused');
  assert.match(r.stderr, /env_id != method_id|DEC-1/);
});

// The load-bearing one: TEST-11 pins licence VERBATIM from method.json, and
// the ITEM-1 TESTS.md note records that 5 of the 95 runnable licences contain
// the study token — so the guard must treat licence as DATA, never as a
// vocabulary scan target. Pinned in both directions below.
test('TEST-1k licence is data: study and placeholder tokens in a licence pass', () => {
  const { manifestPath } = fixture();
  const p = withMutated(manifestPath, (m) => {
    m.envs[0].licence = 'TODO-product: n/a (the paper studies …)';
  });
  const r = guard(['--manifest', p]);
  assert.equal(r.status, 0, `licence must be treated as data: ${r.stderr}`);
});

test('TEST-1l a missing licence is refused', () => {
  const { manifestPath } = fixture();
  const p = withMutated(manifestPath, (m) => { delete m.envs[0].licence; });
  const r = guard(['--manifest', p]);
  assert.equal(r.status, 1, 'a missing licence must be refused');
  assert.match(r.stderr, /licence/);
});

// ── TEST-2: regen parity (the generator's --check and the guard's leg) ────────
test('TEST-2 fixture regen parity is byte-identical', () => {
  const { staging, methodsDir, manifestPath } = fixture();
  const r = gen(['--check', '--fixture', staging, '--methods-dir', methodsDir, '--manifest', manifestPath]);
  assert.equal(r.status, 0, `parity must be byte-identical: ${r.stderr}`);
  assert.match(r.stdout, /MANIFEST OK/);
});

test('TEST-2b parity fails naming the first differing key after a manual edit', () => {
  const { staging, methodsDir, manifestPath } = fixture();
  const p = withMutated(manifestPath, (m) => { m.envs[1].licence = 'edited licence'; });
  const r = gen(['--check', '--fixture', staging, '--methods-dir', methodsDir, '--manifest', p]);
  assert.equal(r.status, 1, 'a manual edit must fail parity');
  assert.match(r.stderr, /envs\[1\]\.licence/);
});

test('TEST-2c parity fails naming an entry\'s source_revision after a bumped revision', () => {
  // The methods commit is per entry (schema 2): a bumped revision fails at
  // that entry's own field.
  const { staging, methodsDir, manifestPath } = fixture();
  const p = withMutated(manifestPath, (m) => { m.envs[1].source_revision = 'ffffffffffff'; });
  const r = gen(['--check', '--fixture', staging, '--methods-dir', methodsDir, '--manifest', p]);
  assert.equal(r.status, 1, 'a bumped revision must fail parity');
  assert.match(r.stderr, /envs\[1\]\.source_revision/);
});

test('TEST-2d the guard\'s parity leg skips with a reason when no staging dir is given', () => {
  const { manifestPath } = fixture();
  const r = guard(['--manifest', manifestPath]);
  assert.equal(r.status, 0, 'skip-with-reason must stay exit 0');
  assert.match(r.stdout + r.stderr, /SKIPPED/);
  assert.match(r.stdout + r.stderr, /staging dir/);
});

test('TEST-2e the guard runs the parity leg when a staging dir is given', () => {
  const { staging, methodsDir, manifestPath } = fixture();
  const r = guard(['--manifest', manifestPath, '--staging-dir', staging, '--methods-dir', methodsDir]);
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.match(r.stdout + r.stderr, /MANIFEST OK/);
});

test('TEST-2f the parity leg fails when the staged records disagree with the manifest', () => {
  const { staging, methodsDir, manifestPath } = fixture();
  const p = withMutated(manifestPath, (m) => { m.envs[0].size_bytes = 999; });
  const r = guard(['--manifest', p, '--staging-dir', staging, '--methods-dir', methodsDir]);
  assert.equal(r.status, 1, 'a disagreeing manifest must fail the parity leg');
  assert.match(r.stderr, /DIFFERS/);
});

test('TEST-2g --require-parity turns a missing staging dir into a failure', () => {
  const { manifestPath } = fixture();
  const r = guard(['--manifest', manifestPath, '--require-parity']);
  assert.equal(r.status, 1, '--require-parity without a staging dir must fail');
  assert.match(r.stderr, /require-parity/);
});

// ── TEST-5: guard + allowlist posture ─────────────────────────────────────────
test('TEST-5 the committed manifest is accepted and the allowlist is untouched', () => {
  const r = guard();
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  const net = spawnSync('bash', [path.join(SCRIPTS_DIR, 'check-network-allowlist.sh')], {
    cwd: REPO,
    encoding: 'utf8',
  });
  assert.equal(net.status, 0, `network-allowlist guard must stay green: ${net.stderr}`);
});

// ── TEST-6: the guard pair is pinned, and unpinning a guard-shaped file fails ─
test('TEST-6 the guard pair is pinned in scripts/guard-hashes.txt', () => {
  const pins = fs.readFileSync(path.join(SCRIPTS_DIR, 'guard-hashes.txt'), 'utf8');
  assert.match(pins, /check-method-env-images\.sh/);
  assert.match(pins, /check-method-env-images\.test\.mjs/);
});

test('TEST-6b an unpinned guard-shaped file fails check 2 of the integrity guard', (t) => {
  const probe = path.join(SCRIPTS_DIR, 'check-__unpinned-probe.sh');
  t.after(() => fs.rmSync(probe, { force: true }));
  fs.writeFileSync(probe, '#!/usr/bin/env bash\nexit 0\n');
  const r = spawnSync('bash', [path.join(SCRIPTS_DIR, 'check-guard-integrity.sh')], {
    cwd: REPO,
    encoding: 'utf8',
  });
  assert.equal(r.status, 1, 'an unpinned guard-shaped file must fail the integrity gate');
  assert.match(r.stdout + r.stderr, /UNPINNED guard on disk/);
  assert.match(r.stdout + r.stderr, /check-__unpinned-probe/);
});

test('TEST-6c the integrity gate passes with both new guards pinned', () => {
  const r = spawnSync('bash', [path.join(SCRIPTS_DIR, 'check-guard-integrity.sh')], {
    cwd: REPO,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /PASS/);
});

// ── TEST-9: the publisher (ITEM-5) ────────────────────────────────────────────
// The publisher is driven with a stub `oras`/`cosign` on PATH. The stubs are
// REAL subprocesses that log their invocation to a file and answer `resolve`
// with a digest supplied by the test — so the assertions are about what the
// publisher actually executed, in order, never about text it printed. The
// stub also logs each call's `--registry-config` (path, mode and content) and
// whether GHCR_TOKEN was in the call's own environment, so the token policy
// is asserted from what oras actually received. The registry is never
// contacted: the artifact checks, the guard preflight and the refusal paths
// are all local, and the stubbed success path witnesses the exact push
// sequence without a network.
function publisher(args = [], env = {}) {
  return spawnSync('bash', [PUBLISHER, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

/** Write the stub tool dir. `resolveDigest` is what `oras resolve` answers,
 *  unless `resolveMap` names the resolved ref (its last argument): then the
 *  map's digest is the answer. A ref in `notFound` answers the ONE shape the
 *  publisher takes for "tag absent" — a "not found" on stderr with a non-zero
 *  exit; an empty successful answer is no longer absence (an unreadable tag
 *  stops the run instead). Returns { dir, bin, log, cfgLog, env }: `log`
 *  holds plain `oras $*` lines, `cfgLog` one line per oras call with its
 *  `--registry-config` path, that file's mode bits and content, and whether
 *  GHCR_TOKEN was in the call's own environment — so a test can assert the
 *  token reaches oras ONLY through the temporary mode-600 config, never a
 *  child's environment. The returned `dir` is the ONLY thing the caller may
 *  clean up. */
function makeStubs(resolveDigest, resolveMap = {}, notFound = []) {
  const dir = mkdtemp('mei-pubstub-');
  const log = path.join(dir, 'calls.log');
  const cfgLog = path.join(dir, 'cfg.log');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const mapFile = path.join(dir, 'resolve.map');
  fs.writeFileSync(mapFile, Object.entries(resolveMap).map(([ref, d]) => `${ref} ${d}\n`).join(''));
  const notFoundFile = path.join(dir, 'notfound.map');
  fs.writeFileSync(notFoundFile, notFound.map((ref) => `${ref}\n`).join(''));
  fs.writeFileSync(path.join(bin, 'oras'), `#!/usr/bin/env sh
echo "oras $*" >> "$ORAS_STUB_LOG"
cfg=""; prev=""
for a in "$@"; do [ "$prev" = "--registry-config" ] && cfg="$a"; prev="$a"; done
mode="-"; text=""
if [ -n "$cfg" ] && [ -f "$cfg" ]; then mode=$(stat -c %a "$cfg"); text=$(cat "$cfg"); fi
tok=false; [ -n "\${GHCR_TOKEN+x}" ] && tok=true
printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$1" "$cfg" "$mode" "$tok" "$text" >> "$ORAS_STUB_CFG_LOG"
case "$1" in
  login) cat >/dev/null ;;
  resolve)
    for a in "$@"; do ref="$a"; done
    if grep -qxF "$ref" "$ORAS_STUB_NOTFOUND"; then echo "Error: not found: $ref" >&2; exit 1; fi
    hit=$(awk -v r="$ref" '$1 == r { print $2; exit }' "$ORAS_STUB_RESOLVE_MAP")
    if [ -n "$hit" ]; then echo "$hit"; else echo "$ORAS_STUB_RESOLVE"; fi ;;
esac
exit 0
`);
  fs.writeFileSync(path.join(bin, 'cosign'), `#!/usr/bin/env sh
echo "cosign $*" >> "$ORAS_STUB_LOG"
exit 0
`);
  fs.chmodSync(path.join(bin, 'oras'), 0o755);
  fs.chmodSync(path.join(bin, 'cosign'), 0o755);
  const env = {
    ORAS_STUB_LOG: log,
    ORAS_STUB_CFG_LOG: cfgLog,
    ORAS_STUB_RESOLVE: resolveDigest,
    ORAS_STUB_RESOLVE_MAP: mapFile,
    ORAS_STUB_NOTFOUND: notFoundFile,
    PATH: `${bin}:${process.env.PATH}`,
  };
  return { dir, bin, log, cfgLog, env };
}

function calls(log) {
  return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
}

/** The per-call records from the stub's config log (one per oras call):
 *  sub, the --registry-config path, that file's mode bits and content, and
 *  whether GHCR_TOKEN was in the call's own environment. */
function cfgDetails(cfgLogPath) {
  if (!fs.existsSync(cfgLogPath)) return [];
  return fs.readFileSync(cfgLogPath, 'utf8').split('\n').filter(Boolean).map((l) => {
    const [sub, config, mode, tokenInEnv, text] = l.split('\t');
    return { sub, config, mode, tokenInEnv, text };
  });
}

/** The publisher's token policy, asserted from the stub's config log: no
 *  `oras login`, every oras call used the SAME temporary registry config,
 *  that config is mode 600 and carries base64(user:token) — the token's only
 *  path to oras — the token is in no oras process's environment, and the
 *  config is removed when the run exits. */
function assertTokenOnlyViaConfig(details, callsLines) {
  assert.ok(!callsLines.some((l) => l.startsWith('oras login')), 'oras login is never called');
  const orasCalls = callsLines.filter((l) => l.startsWith('oras '));
  assert.equal(details.length, orasCalls.length, 'every oras call is in the config log');
  assert.equal(new Set(details.map((d) => d.config)).size, 1, 'the whole run used one registry config');
  const auth = Buffer.from('stub-user:stub-token').toString('base64');
  for (const d of details) {
    assert.ok(d.config.endsWith('/auth/registry-config.json'), `${d.sub}: the token's config`);
    assert.equal(d.mode, '600', `${d.sub}: the token's config is mode 600`);
    assert.ok(d.text.includes(auth), `${d.sub}: the config carries base64(user:token)`);
    assert.equal(d.tokenInEnv, 'false', `${d.sub}: GHCR_TOKEN was never in the oras process environment`);
  }
  assert.ok(!fs.existsSync(details[0].config), 'the token config is removed on exit');
}

const CROSS_HOST = (() => {
  const host = process.arch === 'arm64' ? 'amd64' : 'arm64';
  return host;
})();

test('TEST-9a the publisher refuses a cross-arch publish without ALLOW_EMULATED_BUILD', () => {
  const { staging, methodsDir, manifestPath } = fixture();
  const r = publisher([
    '--env', 'fixture-a', '--arch', CROSS_HOST,
    '--manifest', manifestPath, '--staging-dir', staging, '--methods-dir', methodsDir,
    '--dry-run',
  ]);
  assert.equal(r.status, 2, 'a cross-arch publish must be refused');
  assert.match(r.stderr, /refusing to publish a/);
  assert.match(r.stderr, new RegExp(CROSS_HOST));
});

test('TEST-9b ALLOW_EMULATED_BUILD=1 opens the gate (the refusal is the arch check, not the entry)', () => {
  const { staging, methodsDir, manifestPath } = fixture();
  const r = publisher([
    '--env', 'fixture-a', '--arch', CROSS_HOST,
    '--manifest', manifestPath, '--staging-dir', staging, '--methods-dir', methodsDir,
    '--dry-run',
  ], { ALLOW_EMULATED_BUILD: '1' });
  // With the gate open the cross-arch refusal is gone; the (amd64-only) fixture
  // manifest then rejects the arm64 entry — proving the gate, not the entry,
  // was the earlier blocker.
  assert.doesNotMatch(r.stderr, /refusing to publish a/);
  assert.match(r.stderr, /no manifest entry for fixture-a-arm64/);
  assert.equal(r.status, 2);
});

test('TEST-9c the publisher requires GHCR_TOKEN/GHCR_USER unless --dry-run', () => {
  const { staging, methodsDir, manifestPath } = fixture();
  const cleanEnv = { GHCR_TOKEN: '', GHCR_USER: '', ...process.env };
  delete cleanEnv.GHCR_TOKEN;
  delete cleanEnv.GHCR_USER;
  const r = publisher([
    '--env', 'fixture-a',
    '--manifest', manifestPath, '--staging-dir', staging, '--methods-dir', methodsDir,
  ], cleanEnv);
  assert.equal(r.status, 2, 'missing credentials must refuse');
  assert.match(r.stderr, /GHCR_TOKEN/);
  assert.match(r.stderr, /GHCR_USER/);
  const dry = publisher([
    '--env', 'fixture-a', '--dry-run',
    '--manifest', manifestPath, '--staging-dir', staging, '--methods-dir', methodsDir,
  ], cleanEnv);
  assert.equal(dry.status, 0, `--dry-run must not need credentials: ${dry.stderr}`);
});

test('TEST-5d the publisher dry-run names only the allowlisted host ghcr.io', () => {
  const { staging, methodsDir, manifestPath } = fixture();
  const r = publisher([
    '--env', 'fixture-a', '--dry-run',
    '--manifest', manifestPath, '--staging-dir', staging, '--methods-dir', methodsDir,
  ]);
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  const out = r.stdout + r.stderr;
  assert.match(out, /ghcr\.io/);
  assert.doesNotMatch(out, /http:\/\//, 'scheme-less refs only (DEC-17)');
  // Everything that looks like a host (scheme-less registry refs) is ghcr.io —
  // the allowlisted registry; the annotation source URL is inside the staged
  // manifest bytes, not in the publish sequence the script prints.
  const hosts = [...out.matchAll(/([a-z0-9.-]+\.[a-z]{2,})[:/]/g)].map((m) => m[1]);
  for (const h of hosts) {
    assert.equal(h, 'ghcr.io', `unexpected host in the publish sequence: ${h}`);
  }
});

test('TEST-9d the publisher refuses to overwrite a tag holding different bytes', (t) => {
  const { staging, methodsDir, manifestPath } = fixture();
  const entry = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).envs[0];
  const other = 'sha256:' + '42'.repeat(32);
  assert.notEqual(entry.digest, other);
  const { dir: stubDir, log, env } = makeStubs(other);
  t.after(() => fs.rmSync(stubDir, { recursive: true, force: true }));
  const r = publisher([
    '--env', 'fixture-a',
    '--manifest', manifestPath, '--staging-dir', staging, '--methods-dir', methodsDir,
  ], { ...env, GHCR_TOKEN: 'stub-token', GHCR_USER: 'stub-user' });
  assert.equal(r.status, 1, 'a different remote digest must refuse the publish');
  assert.match(r.stderr, /already exists at/);
  assert.match(r.stderr, new RegExp(other));
  assert.match(r.stderr, new RegExp(entry.digest.replace(/:/g, ':')));
  const c = calls(log);
  assert.ok(c.some((l) => l.startsWith('oras resolve')), 'the tag was resolved first');
  assert.ok(!c.some((l) => /oras (blob|manifest) push/.test(l)),
    'nothing was pushed when the tag held different bytes');
});

test('TEST-9e the full stubbed sequence publishes and verifies the digest', (t) => {
  const { staging, methodsDir, manifestPath } = fixture();
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const entry = m.envs[0];
  const pyBase = m.bases.find((b) => b.base_id === 'base-py' && b.arch === 'amd64');
  const baseRef = `${pyBase.oci_ref}:${pyBase.tag}`;
  const tagA = `fixture-a-2.0.0-amd64-${layerSha12(staging, 'fixture-a-amd64')}`;
  assert.equal(entry.tag, tagA);
  assert.equal(baseRef, `${BASE_PACKAGE}:base-py-2.0-amd64-${pyBase.squashfs_sha256.slice(0, 12)}`);
  const { dir: stubDir, log, cfgLog: stubCfgLog, env } = makeStubs(entry.digest, { [baseRef]: pyBase.digest });
  t.after(() => fs.rmSync(stubDir, { recursive: true, force: true }));
  const r = publisher([
    '--env', 'fixture-a',
    '--manifest', manifestPath, '--staging-dir', staging, '--methods-dir', methodsDir,
  ], { ...env, GHCR_TOKEN: 'stub-token', GHCR_USER: 'stub-user' });
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.match(r.stdout + r.stderr, new RegExp(`published.*${entry.digest}`));
  assert.match(
    r.stdout + r.stderr,
    /\[method-env\] verified/,
    'the full sequence must pass ITEM-7\'s behavioral verifier on the real staged layer',
  );
  const c = calls(log);
  // The step ORDER is unchanged: tag resolve → base resolve → blob(s) →
  // manifest → post-push witness → sign. The only difference from the old
  // sequence is that `oras login` is gone and every oras call carries its
  // temporary --registry-config (stripped below before the comparison).
  const seq = c.map((l) => l.replace(/\s--registry-config \S+/, ''));
  assert.deepEqual(seq, [
    `oras resolve ${LAYER_PACKAGE}:${tagA}`,
    `oras resolve ${baseRef}`,
    `oras blob push ${LAYER_PACKAGE} layer.squashfs`,
    `oras blob push ${LAYER_PACKAGE} ${path.join(staging, 'publish', 'empty-config.json')}`,
    `oras manifest push ${LAYER_PACKAGE}:${tagA} ${path.join(staging, 'layers', 'fixture-a-amd64', 'oci-manifest.json')}`,
    `oras resolve ${LAYER_PACKAGE}:${tagA}`,
    `cosign sign --yes ${LAYER_PACKAGE}@${entry.digest}`,
  ], `the publish sequence must be resolve → base resolve → blob → blob → manifest → resolve → sign:\n${c.join('\n')}`);
  assertTokenOnlyViaConfig(cfgDetails(stubCfgLog), c);
});

test('TEST-9f the publisher verifies the staged bytes are the entry bytes', () => {
  const { staging, methodsDir, manifestPath } = fixture();
  // Tamper the staged layer bytes AFTER the manifest pins their hash.
  const squashfs = path.join(staging, 'layers', 'fixture-a-amd64', 'layer.squashfs');
  fs.writeFileSync(squashfs, Buffer.alloc(4096, 7));
  const r = publisher([
    '--env', 'fixture-a',
    '--manifest', manifestPath, '--staging-dir', staging, '--methods-dir', methodsDir,
  ]);
  assert.equal(r.status, 1, 'a diverged layer file must refuse the publish');
  assert.match(r.stderr, /sha256 .*!= manifest layer_sha256/);
});

// ── ITEM-6: the full-generation manifest (TEST-10/TEST-11) ────────────────────

test('TEST-10 the full-generation run emits exactly one entry per runnable method', () => {
  const { methodsDir, staging, manifestPath } = fixtureFull();
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  // The runnable set is the gated method folders of the repository (no
  // index.json): fixture-c's gate failed.
  const runnable = fs.readdirSync(path.join(methodsDir, 'methods'))
    .filter((id) => JSON.parse(fs.readFileSync(path.join(methodsDir, 'gates', `${id}.json`), 'utf8')).pass === true)
    .sort();
  assert.deepEqual(runnable, ['fixture-a', 'fixture-b', 'fixture-d']);
  const keys = m.envs.map((e) => `${e.env_id}-${e.arch}`);
  // exactly the runnable set — the non-runnable fixture has no entry, and the
  // arm64 record made its way in under a second arch of the SAME env id.
  assert.deepEqual(
    [...m.envs].map((e) => e.env_id).sort(),
    runnable,
    `one entry per runnable method (got ${m.envs.map((e) => e.env_id).join(', ')})`,
  );
  const pairs = m.envs.map((e) => `${e.env_id}|${e.arch}`);
  assert.equal(new Set(pairs).size, pairs.length, 'no duplicate (env_id, arch)');
  for (const e of m.envs) {
    assert.match(e.tag, new RegExp(`^${e.env_id}-${e.method_version}-(amd64|arm64)-${e.layer_sha256.slice(0, 12)}$`),
      `${e.env_id}: per-arch tag <env_id>-<version>-<arch>-<sha12> (DEC-2), got ${e.tag}`);
  }
  const d = m.envs.find((e) => e.env_id === 'fixture-d');
  assert.equal(d.arch, 'arm64');
  assert.equal(d.tag, `fixture-d-1.5.0-arm64-${layerSha12(staging, 'fixture-d-arm64')}`);
  // deterministic order (DEC-15): strict (env_id, arch) ascending.
  const sorted = [...m.envs].sort((x, y) => {
    if (x.env_id !== y.env_id) return x.env_id < y.env_id ? -1 : 1;
    return x.arch < y.arch ? -1 : 1;
  });
  assert.deepEqual(keys, sorted.map((e) => `${e.env_id}-${e.arch}`));
  // the real guard accepts the full-generation manifest (schema + structural).
  const g = guard(['--manifest', manifestPath]);
  assert.equal(g.status, 0, `the guard refused the full-generation manifest: ${g.stderr}`);
  // a record for a NON-runnable method must refuse the write — "exactly the
  // runnable methods" is enforced by the writer (DEC-8), not a coincidence of
  // the fixture.
  const commit = git(methodsDir, ['rev-parse', 'HEAD']);
  stageMethodLayer(path.dirname(staging), staging, methodsDir, commit, SPEC_C,
    { ...RECORD_A, env_id: 'fixture-c', method_id: 'fixture-c', method_version: '1.0.0' });
  const out = path.join(path.dirname(manifestPath), 'manifest-must-not-write.json');
  const r = gen(['--fixture', staging, '--methods-dir', methodsDir, '--manifest', out, '--full']);
  assert.notEqual(r.status, 0, 'a record for a non-runnable method must refuse');
  assert.match(r.stderr, /fixture-c/);
  assert.match(r.stderr, /PROVENANCE_NOT_GATED/);
  assert.match(r.stderr, /not runnable/);
  assert.ok(!fs.existsSync(out), 'nothing is written');
});

test('TEST-11 every entry carries the provenance triplet and the verbatim licence', () => {
  const { base, methodsDir, staging, manifestPath, commit, commit2 } = fixtureFull();
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(m.base_contract, '2.0');
  const builtAt = { 'fixture-a': commit, 'fixture-b': commit, 'fixture-d': commit2 };
  for (const e of m.envs) {
    // non-empty identity + provenance fields (INV-6: a run and a saved model
    // record these verbatim — method, method version, base digest, env digest).
    for (const f of ['method_id', 'method_version', 'digest', 'base_digest',
                     'oci_ref', 'tag', 'wrapper_code_sha256', 'layer_sha256',
                     'source_revision', 'source_tree', 'generator_version']) {
      assert.ok(e[f] && String(e[f]).length > 0, `${e.env_id}: ${f} must be non-empty`);
    }
    assert.match(e.digest, /^sha256:[0-9a-f]{64}$/);
    assert.match(e.base_digest, /^sha256:[0-9a-f]{64}$/);
    assert.match(e.layer_sha256, /^[0-9a-f]{64}$/);
    assert.equal(e.oci_ref, LAYER_PACKAGE);
    // the contract is the FROM tag of the method's Dockerfile at its commit.
    assert.equal(e.contract, '2.0');
    // each entry names the commit its layer was built at and that commit's
    // folder tree; the generator that built it comes from its record.
    assert.equal(e.source_revision, builtAt[e.env_id].slice(0, 12));
    assert.equal(e.source_tree, git(methodsDir, ['rev-parse', `${builtAt[e.env_id]}:methods/${e.env_id}`]));
    assert.equal(e.generator_version, '0.5.0');
    // the licence reproduced VERBATIM from method.json at that commit.
    const mj = JSON.parse(git(methodsDir, ['show', `${builtAt[e.env_id]}:methods/${e.env_id}/method.json`]));
    assert.equal(e.licence, mj.licence);
    assert.equal(e.licence, `verbatim-licence-of-${e.env_id}-LLC`);
  }
  // A licence change is a REBUILD event: the facts are read at each record's
  // own commit, so a new method.json (committed or not) changes nothing until
  // the layer is rebuilt from it — the list's licence can never drift from the
  // method.json inside the layer.
  const revised = 'verbatim-licence-of-fixture-a-LLC-revised-by-the-facts';
  const specA2 = { ...SPEC_A, licence: revised };
  writeMethodFolder(methodsDir, specA2);
  const commit3 = commitAll(methodsDir, 'fixture-a: revised licence');
  const same = path.join(base, 'manifest-same-records.json');
  let r = gen(['--fixture', staging, '--methods-dir', methodsDir, '--manifest', same, '--full']);
  assert.equal(r.status, 0, `re-assembly refused: ${r.stderr}`);
  assert.equal(fs.readFileSync(same, 'utf8'), fs.readFileSync(manifestPath, 'utf8'),
    'the same records give the same list, whatever the methods HEAD');
  stageMethodLayer(base, staging, methodsDir, commit3, specA2, RECORD_A);
  const regenerated = path.join(base, 'manifest-regen.json');
  r = gen(['--fixture', staging, '--methods-dir', methodsDir, '--manifest', regenerated, '--full']);
  assert.equal(r.status, 0, `regeneration refused: ${r.stderr}`);
  const a2 = JSON.parse(fs.readFileSync(regenerated, 'utf8')).envs.find((e) => e.env_id === 'fixture-a');
  assert.equal(a2.licence, revised);
  assert.equal(a2.source_revision, commit3.slice(0, 12));
});

// ── TEST-8: the behavioral verifier (ITEM-7) ─────────────────────────────────
// `scripts/lib/method-env-verify.sh` is the publisher's pre-push gate (PLAN
// note u: `txr_method_env_verify_layer LAYER_DIR RECORD`, non-zero refuses).
// These assertions drive the REAL library over REAL squashfs bytes; the layer
// fixtures are built with mksquashfs, so a source-side drift can never satisfy
// them (a comment does not put a marker in a squashfs).
const VERIFY_LIB = path.join(SCRIPTS_DIR, 'lib', 'method-env-verify.sh');

function verifyLayer(layerDir, recordFile) {
  return spawnSync('bash', [
    '-c', '. "$1"; txr_method_env_verify_layer "$2" "$3"', 'verify-driver',
    VERIFY_LIB, layerDir, recordFile,
  ], { cwd: REPO, encoding: 'utf8' });
}

/** A one-method fixture (env id `fixture-v`) whose staged layer is REAL;
 *  `withRun: false` builds the layer without /code/run.py (TEST-8's broken
 *  artifact) while the record still hashes the real bytes. */
function verifyFixture({ withRun = true } = {}) {
  const base = mkdtemp('mei-ver-');
  const methodsDir = path.join(base, 'methods');
  const staging = path.join(base, 'staged');
  const manifestPath = path.join(base, 'manifest.json');
  const id = 'fixture-v';
  const spec = { id, licence: 'verbatim-licence-of-fixture-v-LLC', language: 'Python',
    version: '1.0.0', run: 'run.py' };
  writeMethodFolder(methodsDir, spec);
  const commit = commitAll(methodsDir, 'fixture-v');
  const dir = path.join(staging, 'layers', `${id}-amd64`);
  stageMethodLayer(base, staging, methodsDir, commit, spec,
    { ...RECORD_A, env_id: id, method_id: id, method_version: '1.0.0' }, { withRun });
  if (!withRun) {
    // The broken layer lacks its run file, but its record carries the
    // committed wrapper hash (the writer checks it against git): every byte
    // check agrees, and only the behavioral verifier can refuse it.
    const committed = createHash('sha256')
      .update(Buffer.concat([Buffer.from(methodJsonText(spec)), Buffer.from(runText('run.py'))]))
      .digest('hex');
    editRecord(path.join(dir, 'artifact.json'), { wrapper_code_sha256: committed });
  }
  stageFixtureBase(base, staging, 'base-py', 'amd64');
  const r = gen(['--fixture', staging, '--methods-dir', methodsDir, '--manifest', manifestPath, '--full']);
  assert.equal(r.status, 0, `TEST-8 fixture manifest did not assemble: ${r.stderr}`);
  return { base, methodsDir, staging, manifestPath, layerDir: dir, recordFile: path.join(dir, 'artifact.json') };
}

function haveTool(tool) {
  return spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).status === 0;
}

test('TEST-8a the verifier passes a well-formed real layer (marker, wrapper, entries)', () => {
  if (!(haveTool('mksquashfs') && haveTool('unsquashfs'))) {
    // Fail-closed with the cause named: the layer fixtures and every assertion
    // below need the real artifact tools (same set the generator's build needs).
    assert.fail('TEST-8 needs mksquashfs + unsquashfs on PATH (squashfs-tools) to build and extract real layer bytes');
  }
  const { layerDir, recordFile } = verifyFixture();
  const r = verifyLayer(layerDir, recordFile);
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.match(r.stdout + r.stderr, /\[method-env\] verified/);
  assert.match(r.stdout + r.stderr, /fixture-v/);
  const rec = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  const bytes = fs.readFileSync(path.join(layerDir, 'layer.squashfs'));
  assert.equal(bytes.length, rec.size_bytes, 'the record size is the staged file size');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), rec.layer_sha256);
});

test('TEST-8b the verifier refuses an absent layer.squashfs', () => {
  if (!(haveTool('mksquashfs') && haveTool('unsquashfs'))) {
    assert.fail('TEST-8 needs mksquashfs + unsquashfs on PATH (squashfs-tools)');
  }
  const { layerDir, recordFile } = verifyFixture();
  fs.rmSync(path.join(layerDir, 'layer.squashfs'));
  const r = verifyLayer(layerDir, recordFile);
  assert.equal(r.status, 1, 'an artifact without layer.squashfs must refuse');
  assert.match(r.stderr, /no layer\.squashfs/);
});

test('TEST-8c the verifier refuses a layer.squashfs whose sha256 differs from the record', () => {
  if (!(haveTool('mksquashfs') && haveTool('unsquashfs'))) {
    assert.fail('TEST-8 needs mksquashfs + unsquashfs on PATH (squashfs-tools)');
  }
  const { layerDir, recordFile } = verifyFixture();
  const entry = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  const squashfs = path.join(layerDir, 'layer.squashfs');
  fs.writeFileSync(squashfs, Buffer.alloc(4096, 7)); // different bytes, same name
  const actual = createHash('sha256').update(fs.readFileSync(squashfs)).digest('hex');
  const r = verifyLayer(layerDir, recordFile);
  assert.equal(r.status, 1, 'a divergent byte sequence must refuse the publish');
  assert.match(r.stderr, /sha256 mismatch/);
  assert.ok(r.stderr.includes(entry.layer_sha256), `the record hash is named: ${r.stderr}`);
  assert.ok(r.stderr.includes(actual), `the staged hash is named: ${r.stderr}`);
});

test('TEST-8d the verifier refuses a layer carrying no /code/run.py or /code/run.R', () => {
  if (!(haveTool('mksquashfs') && haveTool('unsquashfs'))) {
    assert.fail('TEST-8 needs mksquashfs + unsquashfs on PATH (squashfs-tools)');
  }
  const { layerDir, recordFile } = verifyFixture({ withRun: false });
  const r = verifyLayer(layerDir, recordFile);
  assert.equal(r.status, 1, 'a wrapper-less layer must refuse');
  assert.match(r.stderr, /EXACTLY ONE/);
  assert.match(r.stderr, /run\.py/);
});

test('TEST-8e the publisher refuses to push when the behavioral verifier fails', () => {
  if (!(haveTool('mksquashfs') && haveTool('unsquashfs'))) {
    assert.fail('TEST-8 needs mksquashfs + unsquashfs on PATH (squashfs-tools)');
  }
  // The broken layer passes every BYTE check (record + manifest + staged bytes
  // agree — the layer just lacks the wrapper), so the refusal must come from
  // the verifier, before any credential/login requirement.
  const { staging, methodsDir, manifestPath } = verifyFixture({ withRun: false });
  const r = publisher([
    '--env', 'fixture-v',
    '--manifest', manifestPath, '--staging-dir', staging, '--methods-dir', methodsDir,
  ]);
  assert.equal(r.status, 1, `the publisher must refuse: ${r.stderr}\n${r.stdout}`);
  assert.match(r.stderr, /refusing: the behavioral verifier failed for fixture-v-amd64/);
});

// ── TEST-12: the layer cover on small base/method trees ───────────────────────
// The generator's own compute_delta + closed_cover, imported by path, over two
// plain directory trees (no docker): the base, and the base plus what the
// method's build added.
const COVER_HARNESS = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("txr_generator", sys.argv[1])
g = importlib.util.module_from_spec(spec)
sys.modules["txr_generator"] = g
spec.loader.exec_module(g)
base, method = sys.argv[2], sys.argv[3]
try:
    delta = g.compute_delta(method, base, g.build_base_index(base))
    print(json.dumps({"entries": g.closed_cover(delta, method, base)}))
except g.BuildError as e:
    print(json.dumps({"error": str(e)}))
`;

/** The base trees: a py-like and an r-like base, each with the /opt/txr-layer mount point. */
const COVER_BASE = {
  'usr/local/lib/python3.11/site-packages/numpy/__init__.py': 'numpy 2.1.3\n',
  'usr/local/lib/R/site-library/survival/DESCRIPTION': 'Version: 3.8-3\n',
  'opt/txrmethod/txrmethod/__init__.py': 'MODE_ENV = "TXRESBENCH_MODE"\n',
  'opt/txr-layer/R-library/': null,
  'code/': null,
};

function writeTree(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(root, rel);
    if (body === null) {
      fs.mkdirSync(p, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body);
    }
  }
}

/** Run the cover for a method that added `added` (path → content, null = dir) to the base. */
function cover(added) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'txr-cover-'));
  try {
    const base = path.join(dir, 'base');
    const method = path.join(dir, 'method');
    writeTree(base, COVER_BASE);
    writeTree(method, COVER_BASE);
    writeTree(method, { 'code/run.py': 'print("fit")\n', ...added });
    const r = spawnSync('python3', ['-c', COVER_HARNESS, GENERATOR, base, method], { encoding: 'utf8' });
    assert.equal(r.status, 0, `the harness itself must run: ${r.stderr}`);
    return JSON.parse(r.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('TEST-12a Python packages under /opt/txr-layer are one entry beside /code', () => {
  const r = cover({
    'opt/txr-layer/lib/python3.11/site-packages/six.py': 'six\n',
    'opt/txr-layer/lib/python3.11/site-packages/numpy/__init__.py': 'numpy 2.0.0\n',
    'opt/txr-layer/lib/python3.11/site-packages/numpy-2.0.0.dist-info/METADATA': 'Version: 2.0.0\n',
    'opt/txr-layer/bin/f2py': '#!/bin/sh\n',
  });
  assert.deepEqual(r, { entries: ['/code', '/opt/txr-layer'] });
});

test('TEST-12b R packages under /opt/txr-layer/R-library (one the base also has) are one entry', () => {
  const r = cover({
    'opt/txr-layer/R-library/glue/DESCRIPTION': 'Version: 1.8.0\n',
    'opt/txr-layer/R-library/survival/DESCRIPTION': 'Version: 3.7-0\n',
  });
  assert.deepEqual(r, { entries: ['/code', '/opt/txr-layer'] });
});

test('TEST-12c a new package in the base\'s own R library is refused, naming the path', () => {
  const r = cover({ 'usr/local/lib/R/site-library/remotes/DESCRIPTION': 'Version: 2.5.0\n' });
  assert.ok(r.error, `must be refused: ${JSON.stringify(r)}`);
  assert.match(r.error, /no mount point/);
  assert.match(r.error, /\/usr\/local\/lib\/R\/site-library\/remotes/);
  assert.match(r.error, /\/opt\/txr-layer/);
});

test('TEST-12d a new folder under /opt is refused, naming the path', () => {
  const r = cover({ 'opt/uv-python/bin/python3': '#!/bin/sh\n' });
  assert.ok(r.error, `must be refused: ${JSON.stringify(r)}`);
  assert.match(r.error, /\/opt\/uv-python/);
});

test('TEST-12e a changed file the base already has stays an entry (its mount point exists)', () => {
  const r = cover({ 'opt/txrmethod/txrmethod/__init__.py': 'MODE_ENV = "TXRESBENCH_MODE"\n# fixture\n' });
  assert.deepEqual(r, { entries: ['/code', '/opt/txrmethod/txrmethod/__init__.py'] });
});

test('TEST-12f a code-only method is just /code', () => {
  assert.deepEqual(cover({}), { entries: ['/code'] });
});

// ── TEST-13: the base artifacts (design §6.3, §7) ─────────────────────────────

/** The pinned base construction (design §6.3), spelled independently of the
 *  generator so a drift on either side shows. */
function expectedBaseOciBytes(rec) {
  return JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    artifactType: 'application/vnd.txr.method-env.base.v1',
    config: {
      mediaType: 'application/vnd.oci.empty.v1+json',
      digest: 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
      size: 2,
    },
    layers: [{
      mediaType: 'application/vnd.txr.method-env.base.v1',
      digest: 'sha256:' + rec.squashfs_sha256,
      size: rec.size_bytes,
      annotations: { 'org.opencontainers.image.title': 'base.squashfs' },
    }],
    annotations: {
      'org.opencontainers.image.source': 'https://github.com/tinnlab/txresbench',
      'com.txr.base_id': rec.base_id,
      'com.txr.arch': rec.arch,
      'com.txr.contract': rec.contract,
      'com.txr.trimmed-from-ref': rec.source_ref,
      'com.txr.trimmed-from-digest': rec.source_digest,
      'com.txr.base_sha256': rec.squashfs_sha256,
    },
  });
}

test('TEST-13a the writer emits bases and stages each base\'s exact OCI manifest bytes', () => {
  const { staging, manifestPath } = fixture();
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.deepEqual(Object.keys(m),
    ['schema_version', 'generator_version', 'base_contract', 'bases', 'envs']);
  assert.deepEqual(m.bases.map((b) => `${b.base_id}-${b.arch}`), ['base-py-amd64', 'base-r-amd64']);
  for (const b of m.bases) {
    assert.deepEqual(Object.keys(b), BASE_FIELDS, 'the schema field order');
    const dir = path.join(staging, 'bases', `${b.base_id}-${b.arch}`);
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'artifact.json'), 'utf8'));
    const bytes = fs.readFileSync(path.join(dir, 'oci-manifest.json'));
    assert.equal(bytes.toString('utf8'), expectedBaseOciBytes(rec), 'the pinned construction');
    assert.equal(b.digest, 'sha256:' + createHash('sha256').update(bytes).digest('hex'));
    assert.equal(b.squashfs_sha256, rec.squashfs_sha256);
    assert.equal(b.oci_ref, BASE_PACKAGE);
    assert.equal(b.tag, `${b.base_id}-2.0-${b.arch}-${rec.squashfs_sha256.slice(0, 12)}`);
    assert.equal(b.source_digest, BASE_SOURCE_DIGEST);
  }
  // Every entry keeps its provenance fields and pairs with its base.
  for (const e of m.envs) {
    const b = m.bases.find((x) => x.base_id === (e.language === 'R' ? 'base-r' : 'base-py') && x.arch === e.arch);
    assert.equal(e.base_digest, b.source_digest);
    assert.equal(e.base_ref, b.source_ref);
  }
});

test('TEST-13b the writer refuses an entry without its staged base', () => {
  const { staging, methodsDir, base } = fixture();
  fs.rmSync(path.join(staging, 'bases', 'base-r-amd64'), { recursive: true, force: true });
  const r = gen(['--fixture', staging, '--methods-dir', methodsDir, '--manifest', path.join(base, 'x.json'), '--full']);
  assert.equal(r.status, 1, 'a layer without its base must not be written');
  assert.match(r.stderr, /fixture-b-amd64: no staged base base-r-amd64/);
});

test('TEST-13c the writer refuses a base packed from another image, naming both digests', () => {
  const { staging, methodsDir, base } = fixture();
  const recPath = path.join(staging, 'bases', 'base-py-amd64', 'artifact.json');
  const rec = JSON.parse(fs.readFileSync(recPath, 'utf8'));
  const other = 'sha256:' + 'cd'.repeat(32);
  fs.writeFileSync(recPath, JSON.stringify({ ...rec, source_digest: other }));
  const r = gen(['--fixture', staging, '--methods-dir', methodsDir, '--manifest', path.join(base, 'x.json'), '--full']);
  assert.equal(r.status, 1, 'a base from another image must not pair');
  assert.ok(r.stderr.includes(other) && r.stderr.includes(BASE_SOURCE_DIGEST), r.stderr);
  assert.match(r.stderr, /design §7/);
});

test('TEST-13d the writer refuses a stray dir or a dir without a record under bases/', () => {
  const { staging, methodsDir, base } = fixture();
  const stray = path.join(staging, 'bases', 'sha256:abababababab-amd64');
  fs.mkdirSync(stray);
  let r = gen(['--fixture', staging, '--methods-dir', methodsDir, '--manifest', path.join(base, 'x.json'), '--full']);
  assert.equal(r.status, 1, 'an old rootfs cache dir under bases/ must be refused');
  assert.match(r.stderr, /base-cache/);
  fs.rmSync(stray, { recursive: true });
  fs.mkdirSync(path.join(staging, 'bases', 'base-py-arm64'));
  r = gen(['--fixture', staging, '--methods-dir', methodsDir, '--manifest', path.join(base, 'x.json'), '--full']);
  assert.equal(r.status, 1, 'a base dir without its record must be refused');
  assert.match(r.stderr, /base-py-arm64 has no artifact\.json/);
});

test('TEST-13e parity covers bases: an edited base pin fails naming it', () => {
  const { staging, methodsDir, manifestPath } = fixture();
  const p = withMutated(manifestPath, (m) => { m.bases[0].squashfs_sha256 = 'f'.repeat(64); });
  const r = gen(['--check', '--fixture', staging, '--methods-dir', methodsDir, '--manifest', p]);
  assert.equal(r.status, 1, 'an edited base pin must fail parity');
  assert.match(r.stderr, /bases\[0\]\.squashfs_sha256/);
});

test('TEST-13f the guard refuses every broken bases rule, naming it', () => {
  const { manifestPath } = fixture();
  const cases = [
    ['a missing base', (m) => { m.bases.splice(1, 1); }, /no base-r-amd64 record in bases/],
    ['an empty bases list', (m) => { m.bases = []; }, /no base-py-amd64 record in bases/],
    ['an entry built on another image', (m) => { m.envs[0].base_digest = 'sha256:' + 'cd'.repeat(32); },
      /design §7 pairing/],
    ['a tag with another hash', (m) => { m.bases[0].tag = 'base-py-2.0-amd64-000000000000'; }, /tag/],
    ['an oci_ref of another base', (m) => { m.bases[0].oci_ref = `${BASE_PACKAGE}/base-r`; },
      /oci_ref/],
    ['an unknown base id', (m) => { m.bases[0].base_id = 'base-x'; }, /base-x/],
    ['another contract', (m) => { m.bases[0].contract = '2.1'; }, /contract/],
    ['a duplicate base', (m) => { m.bases.push({ ...m.bases[0] }); }, /unique|duplicate/],
    ['unsorted bases', (m) => { m.bases.reverse(); }, /sorted/],
    ['an unused base', (m) => {
      const extra = { ...m.bases[0], arch: 'arm64', tag: m.bases[0].tag.replace('amd64', 'arm64') };
      m.bases.splice(1, 0, extra);
    }, /no entry uses this base/],
    ['a source image of the other family', (m) => {
      m.bases[0].source_ref = 'ghcr.io/tinnlab/txresbench-base-r:2.0';
    }, /source_ref/],
    ['a malformed file pin', (m) => { m.bases[0].squashfs_sha256 = 'A'.repeat(64); }, /squashfs_sha256/],
    ['a zero size', (m) => { m.bases[0].size_bytes = 0; }, /size_bytes/],
    ['an unknown field', (m) => { m.bases[0].extra = 1; }, /additional property/],
    ['placeholder text', (m) => { m.bases[0].source_ref = 'ghcr.io/tinnlab/txresbench-base-py:TODO'; },
      /placeholder/i],
  ];
  for (const [what, mutate, re] of cases) {
    const p = withMutated(manifestPath, mutate);
    const r = guard(['--manifest', p]);
    assert.equal(r.status, 1, `${what} must be refused: ${r.stdout}`);
    assert.match(r.stderr, re, `${what}: ${r.stderr}`);
  }
});

test('TEST-13g a manifest without bases is checked exactly as before', () => {
  const { manifestPath } = fixture();
  const p = withMutated(manifestPath, (m) => { delete m.bases; });
  const r = guard(['--manifest', p]);
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.match(r.stdout, /no bases list/);
  const ok = guard(['--manifest', manifestPath]);
  assert.equal(ok.status, 0, `${ok.stderr}\n${ok.stdout}`);
  assert.match(ok.stdout, /2 bases/);
});

// The generator's own base pack, imported by path (the TEST-12 harness shape).
const PACK_HARNESS = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("txr_generator", sys.argv[1])
g = importlib.util.module_from_spec(spec)
sys.modules["txr_generator"] = g
spec.loader.exec_module(g)
root, out, base_id = sys.argv[2], sys.argv[3], sys.argv[4]
try:
    rec = g.pack_base(root, out, base_id=base_id, arch="amd64",
                      source_ref="ghcr.io/tinnlab/txresbench-%s:2.0" % base_id,
                      source_digest="sha256:" + "ab" * 32,
                      source_ref_source="local", source_digest_source="repo_digests")
    print(json.dumps({"record": rec}))
except g.BuildError as e:
    print(json.dumps({"error": str(e)}))
`;

function pack(root, out, baseId) {
  const r = spawnSync('python3', ['-c', PACK_HARNESS, GENERATOR, root, out, baseId], { encoding: 'utf8' });
  assert.equal(r.status, 0, `the harness itself must run: ${r.stderr}`);
  const last = r.stdout.trim().split('\n').pop();
  return JSON.parse(last);
}

test('TEST-13h one base rootfs packs to the same bytes every time', () => {
  if (!(haveTool('mksquashfs') && haveTool('unsquashfs'))) {
    assert.fail('TEST-13h needs mksquashfs + unsquashfs on PATH (squashfs-tools)');
  }
  const dir = mkdtemp('mei-basepack-');
  const root = path.join(dir, 'root');
  writeBaseRoot(root, 'base-py');
  const first = pack(root, path.join(dir, 'one'), 'base-py');
  assert.ok(first.record, JSON.stringify(first));
  // New file times (an extraction at another moment) must not change a byte.
  const later = new Date(Date.now() + 3600 * 1000);
  fs.utimesSync(path.join(root, 'usr', 'bin', 'bash'), later, later);
  fs.utimesSync(path.join(root, 'opt', 'txr-layer'), later, later);
  const second = pack(root, path.join(dir, 'two'), 'base-py');
  assert.equal(second.record.squashfs_sha256, first.record.squashfs_sha256, 'deterministic pack');
  const bytes = fs.readFileSync(path.join(dir, 'two', 'base.squashfs'));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), second.record.squashfs_sha256);
  assert.equal(second.record.size_bytes, bytes.length);
  assert.equal(second.record.oci_ref, BASE_PACKAGE);
  assert.equal(second.record.tag, `base-py-2.0-amd64-${second.record.squashfs_sha256.slice(0, 12)}`);
  assert.equal(second.record.kind, 'base');
  assert.equal(second.record.source_digest, 'sha256:' + 'ab'.repeat(32));
  const rec = JSON.parse(fs.readFileSync(path.join(dir, 'two', 'artifact.json'), 'utf8'));
  assert.deepEqual(rec, second.record, 'the record on disk is the returned record');
});

test('TEST-13i a base rootfs without what the stacked run needs is refused, naming the path', () => {
  if (!(haveTool('mksquashfs') && haveTool('unsquashfs'))) {
    assert.fail('TEST-13i needs mksquashfs + unsquashfs on PATH (squashfs-tools)');
  }
  const dir = mkdtemp('mei-basecheck-');
  const cases = [
    ['base-py', { omit: ['usr/bin/prlimit'] }, '/usr/bin/prlimit'],
    ['base-py', { omit: ['usr/bin/bash'] }, '/usr/bin/bash'],
    ['base-py', { omit: ['opt/txr-layer/'] }, '/opt/txr-layer'],
    ['base-r', { omit: ['opt/txr-layer/R-library/'] }, '/opt/txr-layer/R-library'],
  ];
  cases.forEach(([baseId, opts, missing], i) => {
    const root = path.join(dir, `root-${i}`);
    writeBaseRoot(root, baseId, opts);
    const out = path.join(dir, `out-${i}`);
    const res = pack(root, out, baseId);
    assert.ok(res.error && res.error.includes(missing), `${missing}: ${JSON.stringify(res)}`);
    assert.ok(!fs.existsSync(path.join(out, 'base.squashfs')), 'nothing is packed');
  });
  // A base without its own /bin passes: the sandbox binds the base's /usr and
  // makes /bin a link to usr/bin itself (the dev publisher's bases look so).
  let root = path.join(dir, 'root-nobin');
  writeBaseRoot(root, 'base-r', { binLink: null });
  let res = pack(root, path.join(dir, 'out-nobin'), 'base-r');
  assert.ok(res.record, JSON.stringify(res));
  // A link inside the base is followed from the base's own root, not the host.
  root = path.join(dir, 'root-link');
  writeBaseRoot(root, 'base-py', { omit: ['usr/bin/bash'] });
  fs.mkdirSync(path.join(root, 'usr', 'libexec'), { recursive: true });
  fs.writeFileSync(path.join(root, 'usr', 'libexec', 'bash'), '#!/bin/sh\n');
  fs.symlinkSync('/usr/libexec/bash', path.join(root, 'usr', 'bin', 'bash'));
  res = pack(root, path.join(dir, 'out-link'), 'base-py');
  assert.ok(res.record, JSON.stringify(res));
});

/** A stub `docker` (a real subprocess, no daemon): `image inspect` answers
 *  RepoDigests with DOCKER_STUB_DIGEST, `export` streams DOCKER_STUB_TAR;
 *  any build exits 1. Every call is logged. */
function makeDockerStub(digest, tarPath) {
  const dir = mkdtemp('mei-dockerstub-');
  const log = path.join(dir, 'calls.log');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env sh
echo "docker $*" >> "$DOCKER_STUB_LOG"
case "$1" in
  image) [ "$3" = "--format" ] && echo "[\\"ghcr.io/tinnlab/txresbench-base@$DOCKER_STUB_DIGEST\\"]"; exit 0 ;;
  create) echo stubcid; exit 0 ;;
  export) cat "$DOCKER_STUB_TAR"; exit 0 ;;
  rm) exit 0 ;;
  *) exit 1 ;;
esac
`);
  fs.chmodSync(path.join(bin, 'docker'), 0o755);
  return {
    log,
    env: { DOCKER_STUB_LOG: log, DOCKER_STUB_DIGEST: digest, DOCKER_STUB_TAR: tarPath,
           PATH: `${bin}:${process.env.PATH}` },
  };
}

function stageBasesSetup() {
  const fx = fixture();
  fs.rmSync(path.join(fx.staging, 'bases'), { recursive: true, force: true });
  const root = path.join(fx.base, 'image-root');
  writeBaseRoot(root, 'base-r');
  const tarPath = path.join(fx.base, 'image.tar');
  const t = spawnSync('tar', ['-cf', tarPath, '-C', root, '.'], { encoding: 'utf8' });
  assert.equal(t.status, 0, t.stderr);
  return { ...fx, tarPath };
}

function stageBases(staging, env) {
  return spawnSync('python3', [GENERATOR, '--stage-bases', '--out', staging, '--arch', 'amd64'], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('TEST-13j --stage-bases refuses a local base image with another digest and never builds', () => {
  const { staging, tarPath } = stageBasesSetup();
  const stub = makeDockerStub('sha256:' + 'cd'.repeat(32), tarPath);
  const r = stageBases(staging, stub.env);
  assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /rebuild the layers and the base together/);
  const log = fs.readFileSync(stub.log, 'utf8');
  assert.doesNotMatch(log, /docker (build|buildx|pull)/, 'a base is never rebuilt or pulled');
  assert.ok(!fs.existsSync(path.join(staging, 'bases', 'base-py-amd64', 'base.squashfs')));
});

test('TEST-13k --stage-bases stages each base from the image with the recorded digest', () => {
  if (!(haveTool('mksquashfs') && haveTool('unsquashfs'))) {
    assert.fail('TEST-13k needs mksquashfs + unsquashfs on PATH (squashfs-tools)');
  }
  const { staging, methodsDir, base, tarPath } = stageBasesSetup();
  const stub = makeDockerStub(BASE_SOURCE_DIGEST, tarPath);
  const r = stageBases(staging, stub.env);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  for (const baseId of ['base-py', 'base-r']) {
    const rec = JSON.parse(fs.readFileSync(path.join(staging, 'bases', `${baseId}-amd64`, 'artifact.json'), 'utf8'));
    assert.equal(rec.source_digest, BASE_SOURCE_DIGEST);
    assert.equal(rec.source_ref, BASE_SOURCE[baseId]);
  }
  const log = fs.readFileSync(stub.log, 'utf8');
  assert.match(log, /docker export stubcid/);
  assert.doesNotMatch(log, /docker (build|buildx|pull)/);
  // Staging again keeps the staged bases (same image, matching files).
  const again = stageBases(staging, stub.env);
  assert.equal(again.status, 0, again.stderr);
  assert.doesNotMatch(again.stdout, /\+ mksquashfs/, 'nothing is packed twice');
  // And the writer pairs every layer with them.
  const w = gen(['--fixture', staging, '--methods-dir', methodsDir, '--manifest', path.join(base, 'staged.json'), '--full']);
  assert.equal(w.status, 0, w.stderr);
  const m = JSON.parse(fs.readFileSync(path.join(base, 'staged.json'), 'utf8'));
  assert.equal(m.bases.length, 2);
});

// ── TEST-14: the publisher's bases and the loopback rehearsal ─────────────────

function baseOf(manifestPath, baseId = 'base-py', arch = 'amd64') {
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return m.bases.find((b) => b.base_id === baseId && b.arch === arch);
}

const CREDS = { GHCR_TOKEN: 'stub-token', GHCR_USER: 'stub-user' };

test('TEST-14a the --base dry run checks every local byte and names only ghcr.io', () => {
  const { staging, methodsDir, manifestPath } = fixture();
  const b = baseOf(manifestPath);
  const r = publisher([
    '--base', 'base-py', '--dry-run',
    '--manifest', manifestPath, '--staging-dir', staging, '--methods-dir', methodsDir,
  ]);
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  const out = r.stdout + r.stderr;
  assert.match(out, /guard {5}: manifest \+ regen parity OK/);
  assert.match(out, /verify {4}: base content OK/);
  const dir = path.join(staging, 'bases', 'base-py-amd64');
  for (const line of [
    `+ oras resolve --registry-config <temp, mode 600> ${b.oci_ref}:${b.tag}`,
    `+ oras blob push --registry-config <temp, mode 600> ${b.oci_ref} ${path.join(dir, 'base.squashfs')}`,
    `+ oras blob push --registry-config <temp, mode 600> ${b.oci_ref} ${path.join(staging, 'publish', 'empty-config.json')}`,
    `+ oras manifest push --registry-config <temp, mode 600> ${b.oci_ref}:${b.tag} ${path.join(dir, 'oci-manifest.json')}`,
    `+ cosign sign --yes ${b.oci_ref}@${b.digest}`,
  ]) {
    assert.ok(out.includes(line), `missing "${line}" in:\n${out}`);
  }
  // The dry run names the token's channel (a temp mode-600 config) but never
  // the token and never `oras login`.
  assert.ok(out.includes('no oras login, and no child process sees GHCR_TOKEN or GHCR_USER'), out);
  assert.doesNotMatch(out, /\+ oras login/, 'the dry run never prints oras login');
  const hosts = [...out.matchAll(/([a-z0-9.-]+\.[a-z]{2,})[:/]/g)].map((x) => x[1]);
  for (const h of hosts) assert.equal(h, 'ghcr.io', `unexpected host in the publish sequence: ${h}`);
});

test('TEST-14b --base refuses bytes, records and manifests that are not the contract', () => {
  const cases = [
    ['a tampered base file', (fx) => {
      fs.writeFileSync(path.join(fx.staging, 'bases', 'base-py-amd64', 'base.squashfs'), Buffer.alloc(4096, 9));
    }, 1, /sha256 .* != manifest squashfs_sha256/],
    ['tampered OCI manifest bytes', (fx) => {
      fs.appendFileSync(path.join(fx.staging, 'bases', 'base-py-amd64', 'oci-manifest.json'), ' ');
    }, 1, /oci-manifest\.json digest .* != manifest digest/],
    ['a record that disagrees', (fx) => {
      const p = path.join(fx.staging, 'bases', 'base-py-amd64', 'artifact.json');
      const rec = JSON.parse(fs.readFileSync(p, 'utf8'));
      fs.writeFileSync(p, JSON.stringify({ ...rec, source_ref: 'ghcr.io/tinnlab/txresbench-base-py:9.9' }));
    }, 1, /record source_ref .* != manifest/],
    ['a manifest without bases', (fx) => {
      const m = JSON.parse(fs.readFileSync(fx.manifestPath, 'utf8'));
      delete m.bases;
      fs.writeFileSync(fx.manifestPath, JSON.stringify(m, null, 2) + '\n');
    }, 1, /has no bases list/],
  ];
  for (const [what, breakIt, status, re] of cases) {
    const fx = fixture();
    breakIt(fx);
    const r = publisher([
      '--base', 'base-py', '--dry-run',
      '--manifest', fx.manifestPath, '--staging-dir', fx.staging, '--methods-dir', fx.methodsDir,
    ]);
    assert.equal(r.status, status, `${what}: ${r.stderr}\n${r.stdout}`);
    assert.match(r.stderr, re, `${what}: ${r.stderr}`);
  }
  const fx = fixture();
  const flags = ['--manifest', fx.manifestPath, '--staging-dir', fx.staging, '--methods-dir', fx.methodsDir,
    '--dry-run'];
  assert.equal(publisher(['--base', 'base-x', ...flags]).status, 2, 'an unknown base id');
  assert.equal(publisher(['--base', 'base-r', '--arch', 'arm64', ...flags], { ALLOW_EMULATED_BUILD: '1' }).status, 2,
    'a base the manifest does not hold');
  const both = publisher(['--base', 'base-py', '--env', 'fixture-a', ...flags]);
  assert.equal(both.status, 2);
  assert.match(both.stderr, /exclusive/);
});

test('TEST-14c --base refuses a base without what the stacked run needs, before any login', (t) => {
  // A truthful record over a base that lacks /usr/bin/prlimit: the writer
  // trusts records; the publisher reads the bytes.
  const fx = fixture();
  fs.rmSync(path.join(fx.staging, 'bases', 'base-py-amd64'), { recursive: true, force: true });
  const root = path.join(fx.base, 'broken-base-root');
  writeBaseRoot(root, 'base-py', { omit: ['usr/bin/prlimit'] });
  stagedBaseRecord(fx.staging, 'base-py', 'amd64', root);
  const w = gen(['--fixture', fx.staging, '--methods-dir', fx.methodsDir, '--manifest', fx.manifestPath, '--full']);
  assert.equal(w.status, 0, w.stderr);
  const { dir: stubDir, log, env } = makeStubs('');
  t.after(() => fs.rmSync(stubDir, { recursive: true, force: true }));
  const r = publisher([
    '--base', 'base-py',
    '--manifest', fx.manifestPath, '--staging-dir', fx.staging, '--methods-dir', fx.methodsDir,
  ], { ...env, ...CREDS });
  assert.equal(r.status, 1, `${r.stderr}\n${r.stdout}`);
  assert.match(r.stderr, /has no \/usr\/bin\/prlimit/);
  assert.ok(!fs.existsSync(log) || calls(log).length === 0, 'no oras or cosign call was made');
});

test('TEST-14d --base refuses a tag that already holds other bytes', (t) => {
  const { staging, methodsDir, manifestPath } = fixture();
  const b = baseOf(manifestPath);
  const other = 'sha256:' + '42'.repeat(32);
  const { dir: stubDir, log, env } = makeStubs(other);
  t.after(() => fs.rmSync(stubDir, { recursive: true, force: true }));
  const r = publisher([
    '--base', 'base-py',
    '--manifest', manifestPath, '--staging-dir', staging, '--methods-dir', methodsDir,
  ], { ...env, ...CREDS });
  assert.equal(r.status, 1, `${r.stderr}\n${r.stdout}`);
  assert.match(r.stderr, /already exists at/);
  assert.ok(r.stderr.includes(other) && r.stderr.includes(b.digest), r.stderr);
  assert.ok(!calls(log).some((l) => /oras (blob|manifest) push/.test(l)), 'nothing was pushed');
});

test('TEST-14e the full stubbed base sequence publishes and verifies the digest', (t) => {
  const { staging, methodsDir, manifestPath } = fixture();
  const b = baseOf(manifestPath);
  const { dir: stubDir, log, cfgLog: stubCfgLog, env } = makeStubs(b.digest);
  t.after(() => fs.rmSync(stubDir, { recursive: true, force: true }));
  const r = publisher([
    '--base', 'base-py',
    '--manifest', manifestPath, '--staging-dir', staging, '--methods-dir', methodsDir,
  ], { ...env, ...CREDS });
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.match(r.stdout, new RegExp(`published : ${b.oci_ref}:${b.tag} @ ${b.digest}`));
  const c = calls(log);
  // The step ORDER is unchanged (no `oras login`; every oras call carries its
  // temporary --registry-config, stripped before the comparison).
  const seq = c.map((l) => l.replace(/\s--registry-config \S+/, ''));
  assert.deepEqual(seq, [
    `oras resolve ${b.oci_ref}:${b.tag}`,
    `oras blob push ${b.oci_ref} base.squashfs`,
    `oras blob push ${b.oci_ref} ${path.join(staging, 'publish', 'empty-config.json')}`,
    `oras manifest push ${b.oci_ref}:${b.tag} ${path.join(staging, 'bases', 'base-py-amd64', 'oci-manifest.json')}`,
    `oras resolve ${b.oci_ref}:${b.tag}`,
    `cosign sign --yes ${b.oci_ref}@${b.digest}`,
  ]);
  assertTokenOnlyViaConfig(cfgDetails(stubCfgLog), c);
});

test('TEST-14f a layer publish refuses until its base is published, then goes on', (t) => {
  const { staging, methodsDir, manifestPath } = fixture();
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const entry = m.envs[0];
  const b = baseOf(manifestPath);
  const layerRef = `${entry.oci_ref}:${entry.tag}`;
  const baseRef = `${b.oci_ref}:${b.tag}`;
  const args = ['--env', 'fixture-a', '--manifest', manifestPath, '--staging-dir', staging, '--methods-dir', methodsDir];
  // The base tag is absent (and the layer tag too): refused, nothing pushed.
  // The stub answers the ONE shape the publisher takes for "absent" — a
  // "not found" on stderr, non-zero exit (a successful empty answer would be
  // an unreadable tag and stop the run at the overwrite check instead).
  let stub = makeStubs('', {}, [layerRef, baseRef]);
  t.after(() => fs.rmSync(stub.dir, { recursive: true, force: true }));
  let r = publisher(args, { ...stub.env, ...CREDS });
  assert.equal(r.status, 1, `${r.stderr}\n${r.stdout}`);
  assert.match(r.stderr, /publish the base first/);
  assert.match(r.stderr, /--base base-py --arch amd64/);
  assert.ok(!calls(stub.log).some((l) => /oras (blob|manifest) push/.test(l)), 'nothing was pushed');
  // The base tag names other bytes: refused the same way.
  stub = makeStubs('', { [baseRef]: 'sha256:' + '42'.repeat(32) }, [layerRef]);
  t.after(() => fs.rmSync(stub.dir, { recursive: true, force: true }));
  r = publisher(args, { ...stub.env, ...CREDS });
  assert.equal(r.status, 1, `${r.stderr}\n${r.stdout}`);
  assert.match(r.stderr, /publish the base first/);
  // The base is published: the layer goes on (the stub answers both tags by
  // ref, so the post-push witness sees the layer digest).
  stub = makeStubs('', { [baseRef]: b.digest, [layerRef]: entry.digest });
  t.after(() => fs.rmSync(stub.dir, { recursive: true, force: true }));
  r = publisher(args, { ...stub.env, ...CREDS });
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.match(r.stdout, /is published/);
  assert.ok(calls(stub.log).map((l) => l.replace(/\s--registry-config \S+/, ''))
    .some((l) => l === `oras manifest push ${layerRef} ${path.join(staging, 'layers', 'fixture-a-amd64', 'oci-manifest.json')}`));
});

test('TEST-14g a layer publish refuses a manifest without bases', () => {
  const { staging, methodsDir, manifestPath } = fixture();
  const p = withMutated(manifestPath, (m) => { delete m.bases; });
  const r = publisher([
    '--env', 'fixture-a', '--dry-run',
    '--manifest', p, '--staging-dir', staging, '--methods-dir', methodsDir,
  ]);
  assert.equal(r.status, 1, `${r.stderr}\n${r.stdout}`);
  assert.match(r.stderr, /has no bases list/);
  assert.match(r.stderr, /could never run/);
});

test('TEST-14h --registry accepts only 127.0.0.1:<port> and [::1]:<port>', () => {
  const { staging, methodsDir, manifestPath } = fixture();
  const args = (reg) => ['--base', 'base-py', '--dry-run', '--registry', reg,
    '--manifest', manifestPath, '--staging-dir', staging, '--methods-dir', methodsDir];
  for (const ok of ['127.0.0.1:5055', '[::1]:5055', '127.0.0.1:65535']) {
    const r = publisher(args(ok));
    assert.equal(r.status, 0, `${ok}: ${r.stderr}`);
  }
  for (const bad of ['ghcr.io', 'localhost:5055', '10.0.0.1:5055', '127.0.0.2:5055', '127.0.0.1',
    '127.0.0.1:0', '127.0.0.1:70000', '127.0.0.1:5055/x', 'http://127.0.0.1:5055', '[::1]',
    '127.0.0.1:5055\nghcr.io:443']) {
    const r = publisher(args(bad));
    assert.equal(r.status, 2, `${bad} must be refused: ${r.stdout}`);
    assert.match(r.stderr, /--registry/);
  }
});

test('TEST-14i a loopback publish is plain HTTP to the loopback host, with no login and no cosign', (t) => {
  const { staging, methodsDir, manifestPath } = fixture();
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const b = baseOf(manifestPath);
  const entry = m.envs[0];
  const reg = '127.0.0.1:5055';
  const local = (ref) => ref.replace(/^ghcr\.io\//, `${reg}/`);
  const stub = makeStubs('', {
    [local(`${b.oci_ref}:${b.tag}`)]: b.digest,
    [local(`${entry.oci_ref}:${entry.tag}`)]: entry.digest,
  });
  t.after(() => fs.rmSync(stub.dir, { recursive: true, force: true }));
  // No credentials in the environment: a loopback publish never reads them.
  const env = { ...process.env, ...stub.env };
  delete env.GHCR_TOKEN;
  delete env.GHCR_USER;
  const common = ['--registry', reg, '--manifest', manifestPath, '--staging-dir', staging, '--methods-dir', methodsDir];
  let r = publisher(['--base', 'base-py', ...common], env);
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  r = publisher(['--env', 'fixture-a', ...common], env);
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  const c = calls(stub.log);
  assert.ok(c.length >= 8, c.join('\n'));
  for (const line of c) {
    assert.match(line, /^oras (resolve|blob push|manifest push) --registry-config \S+ --plain-http /,
      `plain HTTP oras only: ${line}`);
    assert.ok(line.includes(`${reg}/tinnlab/`), `loopback host: ${line}`);
    assert.doesNotMatch(line, /ghcr\.io/, `never ghcr.io: ${line}`);
  }
  assert.ok(c.some((l) => l.startsWith('oras resolve')
    && l.includes(`${reg}/tinnlab/txresbench-env:${b.tag}`)
    && l.includes('--plain-http')), 'the base-first check went to the loopback');
  assert.ok(!c.some((l) => l.startsWith('oras login')), 'no oras login on a loopback rehearsal');
  assert.match(r.stdout, /SIGNING SKIPPED: loopback rehearsal/);
  // The rehearsal passed oras the ANONYMOUS empty {} config — no credentials
  // are read, and none reach a child's environment.
  for (const d of cfgDetails(stub.cfgLog)) {
    assert.equal(d.text, '{}', `${d.sub}: the loopback config is the empty anonymous one`);
    assert.match(d.config, /empty-registry-config\.json$/, `${d.sub}: never the token's config`);
    assert.equal(d.tokenInEnv, 'false', `${d.sub}: no token in the oras process environment`);
  }
});

// ── TEST-15: one package for every layer, one for both bases ──────────────────

/** Rewrite every staged record under `staging` to what a generator before
 *  0.4.0 wrote: the address of one package per method (one per base), and a
 *  record_schema_version 1 layer record with no folder tree (the writer
 *  takes the tree from git at the record's commit); every other field and
 *  every staged file stays as it is. */
function toLegacyRecords(staging) {
  for (const name of fs.readdirSync(path.join(staging, 'layers'))) {
    const p = path.join(staging, 'layers', name, 'artifact.json');
    const r = JSON.parse(fs.readFileSync(p, 'utf8'));
    delete r.source_tree;
    fs.writeFileSync(p, JSON.stringify({
      ...r, record_schema_version: 1,
      oci_ref: `${LAYER_PACKAGE}/${r.env_id}`, tag: `${r.method_version}-${r.arch}`,
    }, null, 2));
  }
  for (const name of fs.readdirSync(path.join(staging, 'bases'))) {
    const p = path.join(staging, 'bases', name, 'artifact.json');
    const r = JSON.parse(fs.readFileSync(p, 'utf8'));
    fs.writeFileSync(p, JSON.stringify({
      ...r, oci_ref: `${BASE_PACKAGE}/${r.base_id}`,
      tag: `${r.contract}-${r.arch}-${r.squashfs_sha256.slice(0, 12)}`,
    }, null, 2));
  }
}

function editRecord(file, fields) {
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...r, ...fields }, null, 2));
}

/** Every staged oci-manifest.json, by its path under `staging`. */
function stagedOciBytes(staging) {
  const out = {};
  for (const kind of ['layers', 'bases']) {
    for (const name of fs.readdirSync(path.join(staging, kind))) {
      const p = path.join(staging, kind, name, 'oci-manifest.json');
      if (fs.existsSync(p)) out[`${kind}/${name}`] = fs.readFileSync(p, 'utf8');
    }
  }
  return out;
}

test('TEST-15a the writer puts every layer in one package and both bases in one package', () => {
  const { staging, manifestPath } = fixtureFull();
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.deepEqual(m.envs.map((e) => [e.oci_ref, e.tag]), [
    [LAYER_PACKAGE, `fixture-a-2.0.0-amd64-${layerSha12(staging, 'fixture-a-amd64')}`],
    [LAYER_PACKAGE, `fixture-b-2.0.0-amd64-${layerSha12(staging, 'fixture-b-amd64')}`],
    [LAYER_PACKAGE, `fixture-d-1.5.0-arm64-${layerSha12(staging, 'fixture-d-arm64')}`],
  ]);
  for (const b of m.bases) {
    assert.equal(b.oci_ref, BASE_PACKAGE);
    assert.equal(b.tag, `${b.base_id}-${b.contract}-${b.arch}-${b.squashfs_sha256.slice(0, 12)}`);
  }
  assert.equal(m.generator_version, '0.6.1');
});

test('TEST-15b records staged before 0.4.0 assemble to the same manifest bytes', () => {
  const { base, staging, methodsDir, manifestPath } = fixture();
  const current = fs.readFileSync(manifestPath, 'utf8');
  const currentOci = stagedOciBytes(staging);
  toLegacyRecords(staging);
  const rec = JSON.parse(fs.readFileSync(path.join(staging, 'layers', 'fixture-a-amd64', 'artifact.json'), 'utf8'));
  assert.equal(rec.oci_ref, `${LAYER_PACKAGE}/fixture-a`, 'the record now carries the old form');
  assert.equal(rec.tag, '2.0.0-amd64');
  // Parity of the current-form manifest against the old-form records.
  const check = gen(['--check', '--fixture', staging, '--methods-dir', methodsDir, '--manifest', manifestPath]);
  assert.equal(check.status, 0, `${check.stderr}\n${check.stdout}`);
  assert.match(check.stdout, /MANIFEST OK/);
  // A fresh write from the old-form records: the same bytes, the same staged
  // OCI manifest bytes (no address is in them), so the same digests.
  const again = path.join(base, 'from-legacy.json');
  const w = gen(['--fixture', staging, '--methods-dir', methodsDir, '--manifest', again, '--full']);
  assert.equal(w.status, 0, w.stderr);
  assert.equal(fs.readFileSync(again, 'utf8'), current);
  assert.deepEqual(stagedOciBytes(staging), currentOci);
  const g = guard(['--manifest', again, '--staging-dir', staging, '--methods-dir', methodsDir]);
  assert.equal(g.status, 0, `${g.stderr}\n${g.stdout}`);
});

test('TEST-15c a staged record with any other address is refused, naming the record', () => {
  const layer = (fx) => path.join(fx.staging, 'layers', 'fixture-a-amd64', 'artifact.json');
  const pyBase = (fx) => path.join(fx.staging, 'bases', 'base-py-amd64', 'artifact.json');
  const sha12 = (fx) => JSON.parse(fs.readFileSync(pyBase(fx), 'utf8')).squashfs_sha256.slice(0, 12);
  const aSha12 = (fx) => layerSha12(fx.staging, 'fixture-a-amd64');
  const layerRefusal = /record fixture-a-amd64: record oci_ref\/tag/;
  const baseRefusal = /base base-py-amd64: record oci_ref\/tag/;
  const cases = [
    ['the current package with the old tag',
      (fx) => editRecord(layer(fx), { tag: '2.0.0-amd64' }), layerRefusal],
    ['the old package with the current tag',
      (fx) => editRecord(layer(fx), { oci_ref: `${LAYER_PACKAGE}/fixture-a` }), layerRefusal],
    ['the old form of another method',
      (fx) => editRecord(layer(fx), { oci_ref: `${LAYER_PACKAGE}/fixture-b`, tag: '2.0.0-amd64' }), layerRefusal],
    ['the tag of another method',
      (fx) => editRecord(layer(fx), { tag: `fixture-b-2.0.0-amd64-${layerSha12(fx.staging, 'fixture-b-amd64')}` }),
      layerRefusal],
    ['the tag of another version',
      (fx) => editRecord(layer(fx), { tag: `fixture-a-2.0.1-amd64-${aSha12(fx)}` }), layerRefusal],
    ['the one-package tag without the hash',
      (fx) => editRecord(layer(fx), { tag: 'fixture-a-2.0.0-amd64' }), layerRefusal],
    ['a tag with another hash',
      (fx) => editRecord(layer(fx), { tag: 'fixture-a-2.0.0-amd64-000000000000' }), layerRefusal],
    ['the base package',
      (fx) => editRecord(layer(fx), { oci_ref: BASE_PACKAGE }), layerRefusal],
    ['a base with the old package and the current tag',
      (fx) => editRecord(pyBase(fx), { oci_ref: `${BASE_PACKAGE}/base-py` }), baseRefusal],
    ['a base with the old form of the other base',
      (fx) => editRecord(pyBase(fx), { oci_ref: `${BASE_PACKAGE}/base-r`, tag: `2.0-amd64-${sha12(fx)}` }), baseRefusal],
    ['a base with the tag of the other base',
      (fx) => editRecord(pyBase(fx), { tag: `base-r-2.0-amd64-${sha12(fx)}` }), baseRefusal],
    ['a base in the layer package',
      (fx) => editRecord(pyBase(fx), { oci_ref: LAYER_PACKAGE }), baseRefusal],
  ];
  for (const [what, breakIt, re] of cases) {
    const fx = fixture();
    breakIt(fx);
    const out = path.join(fx.base, 'must-not-write.json');
    const r = gen(['--fixture', fx.staging, '--methods-dir', fx.methodsDir, '--manifest', out, '--full']);
    assert.equal(r.status, 1, `${what}: ${r.stderr}\n${r.stdout}`);
    assert.match(r.stderr, re, `${what}: ${r.stderr}`);
    assert.ok(!fs.existsSync(out), `${what}: nothing is written`);
  }
});

test('TEST-15d the guard refuses the old addresses, a tag of another entry and an over-long tag', () => {
  const { manifestPath } = fixture();
  const fm = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const sha12 = fm.bases[0].squashfs_sha256.slice(0, 12);
  const aSha12 = fm.envs[0].layer_sha256.slice(0, 12);
  // A 104-character env id spells a 129-character tag (`-2.0.0-amd64-<12 hex>`
  // is 25).
  const long = 'a'.repeat(104);
  const cases = [
    ['the old per-method package', (m) => { m.envs[0].oci_ref = `${LAYER_PACKAGE}/fixture-a`; }, /oci_ref/],
    ['the old tag', (m) => { m.envs[0].tag = '2.0.0-amd64'; }, /tag/],
    ['the tag of another method', (m) => { m.envs[0].tag = m.envs[1].tag; },
      /tag 'fixture-b-2\.0\.0-amd64-[0-9a-f]{12}' != 'fixture-a-2\.0\.0-amd64-[0-9a-f]{12}'/],
    ['the tag of another version', (m) => { m.envs[0].tag = `fixture-a-2.0.1-amd64-${aSha12}`; }, /tag/],
    ['the tag of another arch', (m) => { m.envs[0].tag = `fixture-a-2.0.0-arm64-${aSha12}`; }, /tag/],
    ['the tag without the hash', (m) => { m.envs[0].tag = 'fixture-a-2.0.0-amd64'; }, /tag/],
    ['a tag with another hash', (m) => { m.envs[0].tag = 'fixture-a-2.0.0-amd64-000000000000'; },
      /tag 'fixture-a-2\.0\.0-amd64-000000000000' != 'fixture-a-2\.0\.0-amd64-[0-9a-f]{12}'/],
    ['a hash that is not the layer file\'s', (m) => {
      m.envs[0].layer_sha256 = 'f'.repeat(64);
    }, /tag 'fixture-a-2\.0\.0-amd64-[0-9a-f]{12}' != 'fixture-a-2\.0\.0-amd64-ffffffffffff'/],
    ['an entry in the base package', (m) => { m.envs[0].oci_ref = BASE_PACKAGE; }, /oci_ref/],
    ['the old per-base package', (m) => { m.bases[0].oci_ref = `${BASE_PACKAGE}/base-py`; }, /oci_ref/],
    ['the old base tag', (m) => { m.bases[0].tag = `2.0-amd64-${sha12}`; }, /tag/],
    ['the tag of the other base', (m) => { m.bases[0].tag = `base-r-2.0-amd64-${sha12}`; },
      /tag 'base-r-2\.0-amd64-[0-9a-f]{12}' != 'base-py-2\.0-amd64-/],
    ['a base in the layer package', (m) => { m.bases[0].oci_ref = LAYER_PACKAGE; }, /oci_ref/],
    ['a tag over 128 characters', (m) => {
      Object.assign(m.envs[0], { env_id: long, method_id: long, tag: `${long}-2.0.0-amd64-${aSha12}` });
    }, /not a valid OCI tag/],
  ];
  for (const [what, mutate, re] of cases) {
    const r = guard(['--manifest', withMutated(manifestPath, mutate)]);
    assert.equal(r.status, 1, `${what} must be refused: ${r.stdout}`);
    assert.match(r.stderr, re, `${what}: ${r.stderr}`);
  }
  // A 128-character tag is a valid OCI tag: the length rule is the OCI limit,
  // nothing tighter.
  const short = 'a'.repeat(103);
  const ok = guard(['--manifest', withMutated(manifestPath, (m) => {
    Object.assign(m.envs[0], { env_id: short, method_id: short, tag: `${short}-2.0.0-amd64-${aSha12}` });
  })]);
  assert.equal(ok.status, 0, `${ok.stderr}\n${ok.stdout}`);
});

test('TEST-15e the guard refuses two entries that share a tag in the one package', () => {
  // `fx` at 1.0.0-2.0.0 and `fx-1.0.0` at 2.0.0, over equal layer files, both
  // spell fx-1.0.0-2.0.0-amd64-<sha12>.
  const { manifestPath } = fixture();
  const h = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).envs[0].layer_sha256.slice(0, 12);
  const p = withMutated(manifestPath, (m) => {
    const a = m.envs[0];
    m.envs = [
      m.envs[1], // fixture-b sorts before fx
      { ...a, env_id: 'fx', method_id: 'fx', method_version: '1.0.0-2.0.0', tag: `fx-1.0.0-2.0.0-amd64-${h}` },
      { ...a, env_id: 'fx-1.0.0', method_id: 'fx-1.0.0', method_version: '2.0.0', tag: `fx-1.0.0-2.0.0-amd64-${h}` },
    ];
  });
  const r = guard(['--manifest', p]);
  assert.equal(r.status, 1, `${r.stdout}`);
  assert.match(r.stderr, new RegExp(
    `envs\\[2\\] fx-1\\.0\\.0-amd64: tag 'fx-1\\.0\\.0-2\\.0\\.0-amd64-${h}' is also envs\\[1\\] fx-amd64's`));
  // Without the second spelling the same manifest is accepted.
  const one = withMutated(p, (m) => { m.envs.pop(); });
  const ok = guard(['--manifest', one]);
  assert.equal(ok.status, 0, `${ok.stderr}\n${ok.stdout}`);
  // Over a different layer file the second entry has its own tag: accepted.
  const other = 'e'.repeat(64);
  const own = withMutated(p, (m) => {
    Object.assign(m.envs[2], { layer_sha256: other, tag: `fx-1.0.0-2.0.0-amd64-${other.slice(0, 12)}` });
  });
  const ok2 = guard(['--manifest', own]);
  assert.equal(ok2.status, 0, `${ok2.stderr}\n${ok2.stdout}`);
});

test('TEST-15f the publisher publishes records staged before 0.4.0 at the one-package address', () => {
  const { staging, methodsDir, manifestPath } = fixture();
  toLegacyRecords(staging);
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const b = m.bases.find((x) => x.base_id === 'base-py');
  const tagA = `fixture-a-2.0.0-amd64-${layerSha12(staging, 'fixture-a-amd64')}`;
  const common = ['--dry-run', '--manifest', manifestPath, '--staging-dir', staging, '--methods-dir', methodsDir];
  const layer = publisher(['--env', 'fixture-a', ...common]);
  assert.equal(layer.status, 0, `${layer.stderr}\n${layer.stdout}`);
  assert.ok(layer.stdout.includes(
    `record    : staged before 0.4.0 at ${LAYER_PACKAGE}/fixture-a:2.0.0-amd64; published at ${LAYER_PACKAGE}:${tagA}\n`),
  layer.stdout);
  assert.ok(layer.stdout.includes(`+ oras manifest push --registry-config <temp, mode 600> ${LAYER_PACKAGE}:${tagA} `), layer.stdout);
  assert.ok(layer.stdout.includes(`+ oras resolve --registry-config <temp, mode 600> ${BASE_PACKAGE}:${b.tag}`), layer.stdout);
  assert.ok(layer.stdout.includes('no oras login, and no child process sees GHCR_TOKEN or GHCR_USER'), layer.stdout);
  const base = publisher(['--base', 'base-py', ...common]);
  assert.equal(base.status, 0, `${base.stderr}\n${base.stdout}`);
  assert.ok(base.stdout.includes(
    `record    : staged before 0.4.0 at ${BASE_PACKAGE}/base-py:2.0-amd64-${b.squashfs_sha256.slice(0, 12)}; published at ${BASE_PACKAGE}:${b.tag}`),
  base.stdout);
  assert.ok(base.stdout.includes(`+ oras manifest push --registry-config <temp, mode 600> ${BASE_PACKAGE}:${b.tag} `), base.stdout);
});

test('TEST-15g the publisher refuses an address that is not the one-package form, before any push', (t) => {
  const layerRec = (fx) => path.join(fx.staging, 'layers', 'fixture-a-amd64', 'artifact.json');
  const baseRec = (fx) => path.join(fx.staging, 'bases', 'base-py-amd64', 'artifact.json');
  const editManifest = (fx, fn) => {
    const m = JSON.parse(fs.readFileSync(fx.manifestPath, 'utf8'));
    fn(m);
    fs.writeFileSync(fx.manifestPath, JSON.stringify(m, null, 2) + '\n');
  };
  const cases = [
    ['--env', 'an entry in the old per-method package',
      (fx) => editManifest(fx, (m) => { m.envs[0].oci_ref = `${LAYER_PACKAGE}/fixture-a`; }),
      /entry oci_ref .* is not ghcr\.io\/tinnlab\/txr-method-env-layers \(the one layer package\)/],
    ['--env', 'an entry with the tag of another method',
      (fx) => editManifest(fx, (m) => { m.envs[0].tag = m.envs[1].tag; }),
      /entry tag fixture-b-2\.0\.0-amd64-[0-9a-f]{12} is not fixture-a-2\.0\.0-amd64-[0-9a-f]{12}\n/],
    ['--env', 'an entry whose tag hash is not its layer_sha256',
      (fx) => editManifest(fx, (m) => { m.envs[0].tag = 'fixture-a-2.0.0-amd64-000000000000'; }),
      /entry tag fixture-a-2\.0\.0-amd64-000000000000 is not fixture-a-2\.0\.0-amd64-[0-9a-f]{12}\n/],
    ['--env', 'an entry whose tag has no hash',
      (fx) => editManifest(fx, (m) => { m.envs[0].tag = 'fixture-a-2.0.0-amd64'; }),
      /entry tag fixture-a-2\.0\.0-amd64 is not fixture-a-2\.0\.0-amd64-[0-9a-f]{12}\n/],
    ['--env', 'a record with the old form of another method',
      (fx) => editRecord(layerRec(fx), { oci_ref: `${LAYER_PACKAGE}/fixture-b`, tag: '2.0.0-amd64' }),
      /record oci_ref\/tag .*fixture-b:2\.0\.0-amd64 is neither entry/],
    ['--env', 'a record with the one-package tag without the hash',
      (fx) => editRecord(layerRec(fx), { tag: 'fixture-a-2.0.0-amd64' }),
      /record oci_ref\/tag ghcr\.io\/tinnlab\/txr-method-env-layers:fixture-a-2\.0\.0-amd64 is neither entry/],
    ['--base', 'a base in the old per-base package',
      (fx) => editManifest(fx, (m) => { m.bases[0].oci_ref = `${BASE_PACKAGE}/base-py`; }),
      /base oci_ref .* is not ghcr\.io\/tinnlab\/txresbench-env \(the one base package\)/],
    ['--base', 'a base with the old tag',
      (fx) => editManifest(fx, (m) => { m.bases[0].tag = m.bases[0].tag.replace(/^base-py-/, ''); }),
      /base tag 2\.0-amd64-[0-9a-f]{12} is not base-py-2\.0-amd64-/],
    ['--base', 'a base record of the other base',
      (fx) => editRecord(baseRec(fx), { oci_ref: `${BASE_PACKAGE}/base-r` }),
      /record oci_ref\/tag .*base-r:.* is neither manifest/],
  ];
  for (const [flag, what, breakIt, re] of cases) {
    const fx = fixture();
    breakIt(fx);
    const stub = makeStubs('');
    t.after(() => fs.rmSync(stub.dir, { recursive: true, force: true }));
    const r = publisher([flag, flag === '--env' ? 'fixture-a' : 'base-py',
      '--manifest', fx.manifestPath, '--staging-dir', fx.staging, '--methods-dir', fx.methodsDir,
    ], { ...stub.env, ...CREDS });
    assert.equal(r.status, 1, `${what}: ${r.stderr}\n${r.stdout}`);
    assert.match(r.stderr, re, `${what}: ${r.stderr}`);
    assert.ok(!fs.existsSync(stub.log) || calls(stub.log).length === 0, `${what}: no oras or cosign call`);
  }
});

// ── TEST-16: one method's build input (the committed folder, the pinned base) ─
// The generator's own functions, imported by path (the TEST-12 harness shape),
// over a real git methods repository; docker is a logging stub with no daemon.

const SOURCE_HARNESS = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("txr_generator", sys.argv[1])
g = importlib.util.module_from_spec(spec)
sys.modules["txr_generator"] = g
spec.loader.exec_module(g)
methods, op = sys.argv[2], sys.argv[3]
try:
    if op == "gated":
        git = g.Git(methods)
        print(json.dumps({"ids": g.gated_method_ids(git, git.commit("HEAD"))}))
    else:
        src = sys.argv[5] if len(sys.argv) > 5 else None
        print(json.dumps({"facts": g.prepare_method_source(methods, sys.argv[4], src)}))
except g.BuildError as e:
    print(json.dumps({"error": str(e)}))
`;

function harness(code, args, env = {}) {
  const r = spawnSync('python3', ['-c', code, GENERATOR, ...args], {
    encoding: 'utf8', env: { ...process.env, ...env },
  });
  assert.equal(r.status, 0, `the harness itself must run: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

const prepare = (methodsDir, id, src) =>
  harness(SOURCE_HARNESS, [methodsDir, 'prepare', id, ...(src ? [src] : [])]);

/** A fresh fixture methods repository (a, b gated; c not) at its first commit. */
function methodsRepo() {
  const base = mkdtemp('mei-src-');
  const methodsDir = path.join(base, 'methods');
  const commit = fixtureMethodsRepo(methodsDir);
  return { base, methodsDir, commit };
}

test('TEST-16a a build refuses a dirty, untracked or ungated method folder, naming it', () => {
  const cases = [
    ['a modified tracked file', (m) => fs.appendFileSync(path.join(m, 'methods', 'fixture-a', 'run.py'), '# local edit\n'),
      'fixture-a', /BUILD_FOLDER_DIRTY: method fixture-a[\s\S]*methods\/fixture-a\/run\.py/],
    ['an untracked file', (m) => fs.writeFileSync(path.join(m, 'methods', 'fixture-a', 'notes.txt'), 'x\n'),
      'fixture-a', /BUILD_FOLDER_DIRTY[\s\S]*methods\/fixture-a\/notes\.txt/],
    ['an edited gate file', (m) => fs.writeFileSync(path.join(m, 'gates', 'fixture-a.json'), '{"pass": false}'),
      'fixture-a', /BUILD_FOLDER_DIRTY[\s\S]*gates\/fixture-a\.json/],
    ['a folder that was never committed', (m) => writeMethodFolder(m, { ...SPEC_A, id: 'fixture-x', gate: null }),
      'fixture-x', /BUILD_METHOD_NOT_IN_COMMIT: method fixture-x: methods\/fixture-x is not in HEAD/],
    ['a failed gate', () => {}, 'fixture-c', /BUILD_NOT_GATED: method fixture-c is not runnable/],
    ['no gate file at all', (m) => {
      fs.rmSync(path.join(m, 'gates', 'fixture-b.json'));
      commitAll(m, 'drop the gate of fixture-b');
    }, 'fixture-b', /BUILD_NOT_GATED: method fixture-b/],
  ];
  for (const [what, breakIt, id, re] of cases) {
    const { methodsDir } = methodsRepo();
    breakIt(methodsDir);
    const res = prepare(methodsDir, id);
    assert.ok(res.error, `${what} must be refused: ${JSON.stringify(res)}`);
    assert.match(res.error, re, what);
  }
  // The CLI refuses before any docker call (a logging stub on PATH).
  const { base, methodsDir } = methodsRepo();
  fs.appendFileSync(path.join(methodsDir, 'methods', 'fixture-a', 'run.py'), '# local edit\n');
  const stub = makeDockerStub('sha256:' + 'cd'.repeat(32), path.join(base, 'none.tar'));
  const r = spawnSync('python3', [GENERATOR, '--out', path.join(base, 'out'), '--methods-dir', methodsDir,
    '--only', 'fixture-a', '--arch', HOST_ARCH, '--new-base'], {
    cwd: REPO, encoding: 'utf8', env: { ...process.env, ...stub.env },
  });
  assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /FAIL fixture-a: BUILD_FOLDER_DIRTY/);
  assert.ok(!fs.existsSync(stub.log), 'docker was never called');
});

test('TEST-16b the build takes its facts from method.json and the Dockerfile at HEAD, never index.json', () => {
  const { methodsDir, commit } = methodsRepo();
  // A stale generated index (gitignored, untracked) naming another version and
  // "not runnable": the P7 shape. It is not read.
  fs.writeFileSync(path.join(methodsDir, 'index.json'), JSON.stringify({
    methods: [{ id: 'fixture-a', version: '9.9.9', language: 'R', contract: '9.9', runnable: false }],
  }));
  const res = prepare(methodsDir, 'fixture-a');
  assert.ok(res.facts, JSON.stringify(res));
  const f = res.facts;
  assert.equal(f.version, '2.0.0');
  assert.equal(f.language, 'Python');
  assert.equal(f.licence, SPEC_A.licence);
  assert.equal(f.base_ref, 'ghcr.io/tinnlab/txresbench-base-py:2.0');
  assert.equal(f.contract, '2.0');
  assert.equal(f.run_file, 'run.py');
  assert.equal(f.gated, true);
  // The record's provenance: HEAD's 12 hex and the folder's git tree.
  assert.equal(f.source_revision, commit.slice(0, 12));
  assert.equal(f.source_tree, git(methodsDir, ['rev-parse', `${commit}:methods/fixture-a`]));
  assert.equal(f.wrapper_code_sha256, createHash('sha256')
    .update(methodJsonText(SPEC_A) + runText('run.py')).digest('hex'));
  // A full build lists the gated folders of HEAD (fixture-c's gate failed).
  assert.deepEqual(harness(SOURCE_HARNESS, [methodsDir, 'gated']), { ids: ['fixture-a', 'fixture-b'] });
});

test('TEST-16c the build context is exactly the committed folder', () => {
  const { base, methodsDir } = methodsRepo();
  // An ignored file in the working folder: not dirty (git ignores it) and not
  // in the export.
  fs.mkdirSync(path.join(methodsDir, 'methods', 'fixture-a', '__pycache__'));
  fs.writeFileSync(path.join(methodsDir, 'methods', 'fixture-a', '__pycache__', 'run.cpython-311.pyc'), 'x');
  fs.writeFileSync(path.join(methodsDir, 'methods', 'fixture-a', 'stray.pyc'), 'x');
  fs.chmodSync(path.join(methodsDir, 'methods', 'fixture-a', 'run.py'), 0o600);
  const src = path.join(base, 'src');
  const res = prepare(methodsDir, 'fixture-a', src);
  assert.ok(res.facts, JSON.stringify(res));
  const dir = res.facts.dir;
  assert.equal(dir, path.join(src, 'methods', 'fixture-a'));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['Dockerfile', 'method.json', 'run.py']);
  assert.equal(fs.readFileSync(path.join(dir, 'method.json'), 'utf8'), methodJsonText(SPEC_A));
  // git records 0644 for the file; the export carries that, not the local 0600.
  assert.equal(fs.statSync(path.join(dir, 'run.py')).mode & 0o777, 0o644);
});

/** A stateful `docker` stub (a real subprocess, no daemon): `image inspect`
 *  answers from a JSON state file {ref: [RepoDigests]}, `tag` adds a ref,
 *  everything else (pull, build) exits 1. Every call is logged. */
function makePinnedDockerStub(refs) {
  const dir = mkdtemp('mei-pinstub-');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const state = path.join(dir, 'state.json');
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(state, JSON.stringify(refs));
  fs.writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env python3
import json, os, sys
with open(os.environ["DOCKER_STUB_LOG"], "a") as f:
    f.write("docker " + " ".join(sys.argv[1:]) + "\\n")
path = os.environ["DOCKER_STUB_STATE"]
refs = json.load(open(path))
args = sys.argv[1:]
def lookup(ref):
    if ref in refs:
        return refs[ref]
    for v in refs.values():
        if ref in v:
            return v
    return None
if args[:2] == ["image", "inspect"]:
    v = lookup(args[-1])
    if v is None:
        sys.exit(1)
    if "--format" in args:
        print(json.dumps(v))
    sys.exit(0)
if args[:1] == ["tag"] and lookup(args[1]) is not None:
    refs[args[2]] = lookup(args[1])
    json.dump(refs, open(path, "w"))
    sys.exit(0)
sys.exit(1)
`);
  fs.chmodSync(path.join(bin, 'docker'), 0o755);
  return {
    log, state,
    env: { DOCKER_STUB_LOG: log, DOCKER_STUB_STATE: state, PATH: `${bin}:${process.env.PATH}` },
  };
}

const PIN_HARNESS = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("txr_generator", sys.argv[1])
g = importlib.util.module_from_spec(spec)
sys.modules["txr_generator"] = g
spec.loader.exec_module(g)
from_ref, pin, op = sys.argv[2], json.loads(sys.argv[3]), sys.argv[4]
try:
    if op == "resolve":
        print(json.dumps({"base": g.resolve_pinned_base(from_ref, pin, "base-py-amd64", "the-list.json")}))
    else:
        g.assert_base_unchanged(from_ref, pin["source_digest"])
        print(json.dumps({"ok": True}))
except g.BuildError as e:
    print(json.dumps({"error": str(e)}))
`;

test('TEST-16d a pinned build uses the local base image at the pinned digest, or refuses', () => {
  const FROM = 'ghcr.io/tinnlab/txresbench-base-py:2.0';
  const REPO_PY = 'ghcr.io/tinnlab/txresbench-base-py';
  const PIN = 'sha256:' + 'ab'.repeat(32);
  const OTHER = 'sha256:' + 'cd'.repeat(32);
  const pin = { source_ref: FROM, source_digest: PIN };
  const run = (refs, p = pin, op = 'resolve') => {
    const stub = makePinnedDockerStub(refs);
    const res = harness(PIN_HARNESS, [FROM, JSON.stringify(p), op], stub.env);
    const log = fs.existsSync(stub.log) ? fs.readFileSync(stub.log, 'utf8') : '';
    return { res, log, state: JSON.parse(fs.readFileSync(stub.state, 'utf8')) };
  };
  // The FROM tag already names the pinned image: used as it is.
  let { res, log } = run({ [FROM]: [`${REPO_PY}@${PIN}`] });
  assert.deepEqual(res.base && [res.base.digest, res.base.source], [PIN, 'local'], JSON.stringify(res));
  assert.doesNotMatch(log, /docker (tag|pull|build|buildx)/);
  // The tag names another image, the pinned one is local by digest: tagged.
  let state;
  ({ res, log, state } = run({ [FROM]: [`${REPO_PY}@${OTHER}`], other: [`${REPO_PY}@${PIN}`] }));
  assert.equal(res.base && res.base.source, 'local-by-digest', JSON.stringify(res));
  assert.match(log, new RegExp(`docker tag ${REPO_PY}@${PIN} ${FROM.replace(/\./g, '\\.')}`));
  assert.deepEqual(state[FROM], [`${REPO_PY}@${PIN}`]);
  assert.doesNotMatch(log, /docker (pull|build|buildx)/, 'never pulled, never rebuilt');
  // The pinned image is not on this machine: refused, never pulled.
  ({ res, log } = run({ [FROM]: [`${REPO_PY}@${OTHER}`] }));
  assert.match(res.error || '', /BUILD_BASE_UNAVAILABLE: the pinned base image ghcr\.io\/tinnlab\/txresbench-base-py@sha256:(ab){32} is not on this machine/);
  assert.match(res.error, /docker save/);
  assert.match(res.error, /docker load/);
  assert.doesNotMatch(log, /docker (pull|build|buildx|tag)/);
  // The list pins no base for the key; the Dockerfile names another base.
  ({ res } = run({}, null));
  assert.match(res.error || '', /BUILD_BASE_NOT_PINNED: the-list\.json pins no base-py-amd64 base/);
  assert.match(res.error, /--new-base/);
  ({ res } = run({}, { source_ref: 'ghcr.io/tinnlab/txresbench-base-py:2.1', source_digest: PIN }));
  assert.match(res.error || '', /BUILD_FROM_NOT_PINNED/);
  // After the build: the tag must still name the pin.
  ({ res } = run({ [FROM]: [`${REPO_PY}@${PIN}`] }, pin, 'after'));
  assert.deepEqual(res, { ok: true });
  ({ res } = run({ [FROM]: [`${REPO_PY}@${OTHER}`] }, pin, 'after'));
  assert.match(res.error || '', /BUILD_BASE_MOVED/);
});

test('TEST-16e the build CLI: a list without bases pins nothing; the base flags are exclusive', () => {
  const { base, methodsDir } = methodsRepo();
  const noBases = path.join(base, 'no-bases.json');
  fs.writeFileSync(noBases, JSON.stringify({ schema_version: 2, envs: [] }));
  const stub = makePinnedDockerStub({});
  const cli = (extra) => spawnSync('python3', [GENERATOR, '--out', path.join(base, 'out'),
    '--methods-dir', methodsDir, '--only', 'fixture-a', '--arch', HOST_ARCH, ...extra], {
    cwd: REPO, encoding: 'utf8', env: { ...process.env, ...stub.env },
  });
  let r = cli(['--base-pins', noBases]);
  assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /FAIL fixture-a: BUILD_BASE_NOT_PINNED/);
  assert.ok(!fs.existsSync(stub.log), 'refused before any docker call');
  r = cli(['--force-base-build']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--force-base-build rebuilds the base: only with --new-base/);
  r = cli(['--new-base', '--base-pins', noBases]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /exclusive/);
  // FOLLOW-UPS 77: a build that writes a manifest must say how.
  r = cli(['--new-base', '--manifest', path.join(base, 'm.json')]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /ASSEMBLE_MODE/);
});

// ── TEST-17: lists assembled one method at a time (per-entry provenance) ──────

/** A one-record staging dir: `spec` built at `commit` (optionally on another
 *  base digest), nothing else. */
function oneRecordStaging(fx, commit, spec, rec, name) {
  const staging = path.join(fx.base, name);
  stageMethodLayer(fx.base, staging, fx.methodsDir, commit, spec, rec);
  return staging;
}

const SPEC_A2 = { ...SPEC_A, version: '2.0.1', licence: 'verbatim-licence-of-fixture-a-LLC-v2' };

/** The fixture, then fixture-a bumped to 2.0.1 in a new commit and rebuilt
 *  alone into its own staging dir. */
function fixtureWithUpdate() {
  const fx = fixture();
  writeMethodFolder(fx.methodsDir, SPEC_A2);
  const commit2 = commitAll(fx.methodsDir, 'fixture-a 2.0.1');
  const one = oneRecordStaging(fx, commit2, SPEC_A2, { ...RECORD_A, method_version: '2.0.1' }, 'staged-one');
  return { ...fx, commit2, one };
}

test('TEST-17a records at different commits and legacy records assemble into one list', () => {
  const fx = fixture();
  // fixture-b rebuilt at a later commit; fixture-a stays a pre-0.5.0
  // (record_schema_version 1, no tree) record of the first commit; the
  // methods HEAD then moves on (another method changes): none of it matters.
  writeMethodFolder(fx.methodsDir, { ...SPEC_B, runExtra: '# b changed\n' });
  const commit2 = commitAll(fx.methodsDir, 'fixture-b changed');
  stageMethodLayer(fx.base, fx.staging, fx.methodsDir, commit2, { ...SPEC_B, runExtra: '# b changed\n' }, RECORD_B);
  const aRec = path.join(fx.staging, 'layers', 'fixture-a-amd64', 'artifact.json');
  const legacy = JSON.parse(fs.readFileSync(aRec, 'utf8'));
  delete legacy.source_tree;
  fs.writeFileSync(aRec, JSON.stringify({ ...legacy, record_schema_version: 1, generator_version: '0.3.0' }, null, 2));
  writeMethodFolder(fx.methodsDir, { ...SPEC_C, licence: 'changed' });
  commitAll(fx.methodsDir, 'an unrelated method changes');
  const out = path.join(fx.base, 'mixed.json');
  const r = gen(['--fixture', fx.staging, '--methods-dir', fx.methodsDir, '--manifest', out, '--full']);
  assert.equal(r.status, 0, r.stderr);
  const m = JSON.parse(fs.readFileSync(out, 'utf8'));
  const [a, b] = m.envs;
  assert.equal(a.source_revision, fx.commit.slice(0, 12));
  assert.equal(a.source_tree, git(fx.methodsDir, ['rev-parse', `${fx.commit}:methods/fixture-a`]),
    'a legacy record gets its tree from git');
  assert.equal(a.generator_version, '0.3.0');
  assert.equal(b.source_revision, commit2.slice(0, 12));
  assert.notEqual(a.source_revision, b.source_revision);
  for (const e of m.envs) assert.deepEqual(Object.keys(e), ENV_FIELDS, 'the schema field order');
  const g = guard(['--manifest', out, '--staging-dir', fx.staging, '--methods-dir', fx.methodsDir]);
  assert.equal(g.status, 0, `${g.stderr}\n${g.stdout}`);
  assert.match(g.stdout, /provenance: OK — 2 entries/);
});

test('TEST-17b each provenance refusal at assembly names the record and writes nothing', () => {
  const cases = [
    ['a version method.json does not have (the P7 shape)', (fx) => editRecord(fx.aRec, {
      method_version: '2.0.1', tag: `fixture-a-2.0.1-amd64-${layerSha12(fx.staging, 'fixture-a-amd64')}`,
    }), /record fixture-a-amd64: PROVENANCE_VERSION_MISMATCH: the record says '2\.0\.1', methods\/fixture-a\/method\.json at [0-9a-f]{12} says '2\.0\.0'/],
    ['a method folder that is in no commit (the P7 shape)', (fx) => {
      const dir = path.join(fx.staging, 'layers', 'fixture-a-amd64');
      const rec = JSON.parse(fs.readFileSync(fx.aRec, 'utf8'));
      fs.renameSync(dir, path.join(fx.staging, 'layers', 'fixture-x-amd64'));
      editRecord(path.join(fx.staging, 'layers', 'fixture-x-amd64', 'artifact.json'), {
        env_id: 'fixture-x', method_id: 'fixture-x', tag: rec.tag.replace('fixture-a', 'fixture-x'),
      });
    }, /record fixture-x-amd64: PROVENANCE_METHOD_NOT_IN_COMMIT: methods\/fixture-x is not in commit/],
    ['an unknown commit', (fx) => editRecord(fx.aRec, { source_revision: 'ffffffffffff' }),
      /record fixture-a-amd64: PROVENANCE_COMMIT_UNKNOWN: commit ffffffffffff/],
    ['another folder tree', (fx) => editRecord(fx.aRec, { source_tree: 'f'.repeat(40) }),
      /record fixture-a-amd64: PROVENANCE_TREE_MISMATCH/],
    ['a layer whose /code is not the commit\'s', (fx) => editRecord(fx.aRec, { wrapper_code_sha256: 'e'.repeat(64) }),
      /record fixture-a-amd64: PROVENANCE_WRAPPER_MISMATCH/],
    ['another base image than the Dockerfile\'s FROM', (fx) => editRecord(fx.aRec, {
      base_ref: 'ghcr.io/tinnlab/txresbench-base-py:2.1' }),
    /record fixture-a-amd64: PROVENANCE_FACT_MISMATCH: record base_ref/],
    ['another language', (fx) => editRecord(fx.aRec, { language: 'R' }),
      /record fixture-a-amd64: PROVENANCE_FACT_MISMATCH: record language 'R' != 'Python'/],
  ];
  for (const [what, breakIt, re] of cases) {
    const fx = fixture();
    fx.aRec = path.join(fx.staging, 'layers', 'fixture-a-amd64', 'artifact.json');
    breakIt(fx);
    const out = path.join(fx.base, 'must-not-write.json');
    const r = gen(['--fixture', fx.staging, '--methods-dir', fx.methodsDir, '--manifest', out, '--full']);
    assert.equal(r.status, 1, `${what}: ${r.stderr}\n${r.stdout}`);
    assert.match(r.stderr, re, `${what}: ${r.stderr}`);
    assert.ok(!fs.existsSync(out), `${what}: nothing is written`);
  }
  // A methods dir that is not a git checkout: every fact needs git.
  const fx = fixture();
  const r = gen(['--fixture', fx.staging, '--methods-dir', fx.staging, '--manifest', path.join(fx.base, 'x.json'), '--full']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is not a git checkout/);
});

test('TEST-17c one method rebuilt alone: the others are carried byte for byte', () => {
  const fx = fixtureWithUpdate();
  const out = path.join(fx.base, 'updated.json');
  const r = gen(['--fixture', fx.one, '--methods-dir', fx.methodsDir, '--previous', fx.manifestPath,
    '--manifest', out]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /replaced : fixture-a-amd64/);
  assert.match(r.stdout, /carried {2}: 1 entry from /);
  const prev = JSON.parse(fs.readFileSync(fx.manifestPath, 'utf8'));
  const m = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(JSON.stringify(m.envs[1]), JSON.stringify(prev.envs[1]), 'fixture-b carried untouched');
  assert.equal(JSON.stringify(m.bases), JSON.stringify(prev.bases), 'the bases carried untouched');
  assert.equal(m.envs[0].method_version, '2.0.1');
  assert.equal(m.envs[0].licence, SPEC_A2.licence);
  assert.equal(m.envs[0].source_revision, fx.commit2.slice(0, 12));
  assert.notEqual(m.envs[0].source_revision, m.envs[1].source_revision);
  // The new entry's OCI manifest bytes are staged next to its record.
  const oci = fs.readFileSync(path.join(fx.one, 'layers', 'fixture-a-amd64', 'oci-manifest.json'));
  assert.equal(m.envs[0].digest, 'sha256:' + createHash('sha256').update(oci).digest('hex'));
  // In place: `--previous X --manifest X` updates X.
  const inPlace = path.join(fx.base, 'in-place.json');
  fs.copyFileSync(fx.manifestPath, inPlace);
  const w = gen(['--fixture', fx.one, '--methods-dir', fx.methodsDir, '--previous', inPlace, '--manifest', inPlace]);
  assert.equal(w.status, 0, w.stderr);
  assert.equal(fs.readFileSync(inPlace, 'utf8'), fs.readFileSync(out, 'utf8'));
  // The same record again: "unchanged".
  const again = gen(['--fixture', fx.one, '--methods-dir', fx.methodsDir, '--previous', out,
    '--manifest', path.join(fx.base, 'again.json')]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /unchanged: fixture-a-amd64/);
  assert.equal(fs.readFileSync(path.join(fx.base, 'again.json'), 'utf8'), fs.readFileSync(out, 'utf8'));
});

test('TEST-17d an incremental assembly refuses what would break the list, naming it', () => {
  const fx = fixtureWithUpdate();
  const out = path.join(fx.base, 'must-not-write.json');
  const asm = (extra, staging = fx.one) => gen(['--fixture', staging, '--methods-dir', fx.methodsDir,
    '--manifest', out, ...extra]);
  const prevWith = (fn) => withMutated(fx.manifestPath, fn);
  const cases = [
    ['a schema 1 previous list', ['--previous', prevWith((m) => { m.schema_version = 1; m.source_revision = 'a'.repeat(12); })],
      /ASSEMBLE_PREVIOUS_SCHEMA: --previous .* is schema_version 1/],
    ['a previous list without bases', ['--previous', prevWith((m) => { delete m.bases; })],
      /ASSEMBLE_PREVIOUS_NO_BASES/],
    ['a drop of an entry the list lacks', ['--previous', fx.manifestPath, '--drop', 'fixture-z-amd64'],
      /ASSEMBLE_DROP_UNKNOWN: --drop fixture-z-amd64/],
    ['a drop of the rebuilt entry', ['--previous', fx.manifestPath, '--drop', 'fixture-a-amd64'],
      /--drop fixture-a-amd64: a staged record rebuilds it too/],
    ['a base batch without its staged base', ['--previous', fx.manifestPath, '--replace-base', 'base-py-amd64'],
      /ASSEMBLE_BASE_BATCH: --replace-base base-py-amd64: no staged base/],
  ];
  for (const [what, extra, re] of cases) {
    const r = asm(extra);
    assert.equal(r.status, 1, `${what}: ${r.stderr}\n${r.stdout}`);
    assert.match(r.stderr, re, `${what}: ${r.stderr}`);
    assert.ok(!fs.existsSync(out), `${what}: nothing is written`);
  }
  // A record built on another base image than the list pins.
  const otherDigest = 'sha256:' + 'ef'.repeat(32);
  const other = oneRecordStaging(fx, fx.commit2, SPEC_A2,
    { ...RECORD_A, method_version: '2.0.1', base_digest: otherDigest }, 'staged-other-base');
  let r = asm(['--previous', fx.manifestPath], other);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /record fixture-a-amd64: ASSEMBLE_BASE_CHANGED: base_digest sha256:(ef){32} != base-py-amd64's source_digest sha256:(ab){32}/);
  // A record of another contract line (its Dockerfile FROM :2.1).
  writeMethodFolder(fx.methodsDir, { ...SPEC_A2, contract: '2.1' });
  const commit3 = commitAll(fx.methodsDir, 'fixture-a on contract 2.1');
  const c21 = oneRecordStaging(fx, commit3, SPEC_A2, { ...RECORD_A, method_version: '2.0.1',
    base_ref: 'ghcr.io/tinnlab/txresbench-base-py:2.1' }, 'staged-2-1');
  r = asm(['--previous', fx.manifestPath], c21);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /ASSEMBLE_CONTRACT: contract '2\.1' is not the list's base_contract '2\.0'/);
  // --replace-base / --drop need --previous; --full and --previous are exclusive.
  for (const extra of [['--full', '--drop', 'fixture-b-amd64'], ['--full', '--previous', fx.manifestPath]]) {
    r = asm(extra);
    assert.equal(r.status, 2, `${extra.join(' ')}: ${r.stderr}`);
  }
  // FOLLOW-UPS 77: no mode, no manifest.
  r = asm([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /ASSEMBLE_MODE/);
  assert.ok(!fs.existsSync(out));
});

test('TEST-17e a base change is a batch: every layer on the new base, or dropped', () => {
  const fx = fixtureWithUpdate();
  // A second Python amd64 method in the list, so the base has two layers.
  const SPEC_E = { id: 'fixture-e', licence: 'verbatim-licence-of-fixture-e-LLC', language: 'Python',
    version: '1.0.0', run: 'run.py' };
  writeMethodFolder(fx.methodsDir, SPEC_E);
  const commitE = commitAll(fx.methodsDir, 'add fixture-e');
  stageMethodLayer(fx.base, fx.staging, fx.methodsDir, commitE, SPEC_E,
    { ...RECORD_A, env_id: 'fixture-e', method_id: 'fixture-e', method_version: '1.0.0' });
  const prev = path.join(fx.base, 'with-e.json');
  let r = gen(['--fixture', fx.staging, '--methods-dir', fx.methodsDir, '--manifest', prev, '--full']);
  assert.equal(r.status, 0, r.stderr);
  // A new base-py image: fixture-a rebuilt on it, its base staged beside it.
  const NEW = 'sha256:' + 'ef'.repeat(32);
  const batch = oneRecordStaging(fx, fx.commit2, SPEC_A2,
    { ...RECORD_A, method_version: '2.0.1', base_digest: NEW }, 'staged-batch');
  stageFixtureBase(fx.base, batch, 'base-py', 'amd64', { source_digest: NEW },
    { extra: { 'usr/share/new-base': 'v2\n' } });
  const out = path.join(fx.base, 'batch.json');
  r = gen(['--fixture', batch, '--methods-dir', fx.methodsDir, '--previous', prev, '--manifest', out,
    '--replace-base', 'base-py-amd64']);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /fixture-e-amd64: ASSEMBLE_BASE_BATCH: the new base-py-amd64 base was packed from sha256:(ef){32}, but fixture-e-amd64, carried from the previous list, was built on sha256:(ab){32}/);
  assert.ok(!fs.existsSync(out));
  r = gen(['--fixture', batch, '--methods-dir', fx.methodsDir, '--previous', prev, '--manifest', out,
    '--replace-base', 'base-py-amd64', '--drop', 'fixture-e-amd64']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /dropped {2}: fixture-e-amd64/);
  assert.match(r.stdout, /bases {4}: from the build dir base-py-amd64/);
  const m = JSON.parse(fs.readFileSync(out, 'utf8'));
  const py = m.bases.find((b) => b.base_id === 'base-py');
  assert.equal(py.source_digest, NEW);
  const staged = JSON.parse(fs.readFileSync(path.join(batch, 'bases', 'base-py-amd64', 'artifact.json'), 'utf8'));
  assert.equal(py.squashfs_sha256, staged.squashfs_sha256);
  assert.ok(fs.existsSync(path.join(batch, 'bases', 'base-py-amd64', 'oci-manifest.json')),
    'the new base\'s OCI bytes are staged for its publish');
  assert.deepEqual(m.envs.map((e) => e.env_id), ['fixture-a', 'fixture-b']);
  // The check of that list against the previous one.
  const c = gen(['--check', '--fixture', batch, '--methods-dir', fx.methodsDir, '--previous', prev, '--manifest', out]);
  assert.equal(c.status, 0, `${c.stderr}\n${c.stdout}`);
  assert.match(c.stdout, /1 carried byte-identical, 1 re-assembled from their records, 1 dropped/);
  // A new base FILE packed from the SAME image keeps every layer paired: no
  // rebuild is needed (the layers pair with the image, not the file).
  const refile = path.join(fx.base, 'staged-refile');
  fs.mkdirSync(path.join(refile, 'layers'), { recursive: true });
  stageFixtureBase(fx.base, refile, 'base-py', 'amd64', {}, { extra: { 'usr/share/repacked': 'x\n' } });
  const out2 = path.join(fx.base, 'refile.json');
  r = gen(['--fixture', refile, '--methods-dir', fx.methodsDir, '--previous', prev, '--manifest', out2,
    '--replace-base', 'base-py-amd64']);
  assert.equal(r.status, 0, r.stderr);
  const m2 = JSON.parse(fs.readFileSync(out2, 'utf8'));
  assert.notEqual(m2.bases[0].squashfs_sha256, JSON.parse(fs.readFileSync(prev, 'utf8')).bases[0].squashfs_sha256);
  assert.equal(JSON.stringify(m2.envs), JSON.stringify(JSON.parse(fs.readFileSync(prev, 'utf8')).envs));
});

test('TEST-17f the first entries of a new arch need their base batch; --drop leaves out an unused base', () => {
  const fx = fixture();
  writeMethodFolder(fx.methodsDir, SPEC_D);
  const commit2 = commitAll(fx.methodsDir, 'add fixture-d');
  const arm = oneRecordStaging(fx, commit2, SPEC_D, RECORD_D, 'staged-arm64');
  stageFixtureBase(fx.base, arm, 'base-py', 'arm64');
  const out = path.join(fx.base, 'with-arm64.json');
  let r = gen(['--fixture', arm, '--methods-dir', fx.methodsDir, '--previous', fx.manifestPath, '--manifest', out]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /record fixture-d-arm64: ASSEMBLE_BASE_CHANGED: the list pins no base-py-arm64 base/);
  r = gen(['--fixture', arm, '--methods-dir', fx.methodsDir, '--previous', fx.manifestPath, '--manifest', out,
    '--replace-base', 'base-py-arm64']);
  assert.equal(r.status, 0, r.stderr);
  let m = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(m.bases.map((b) => `${b.base_id}-${b.arch}`), ['base-py-amd64', 'base-py-arm64', 'base-r-amd64']);
  assert.match(r.stdout, /added {4}: fixture-d-arm64/);
  // Drop the only R entry: its base goes too.
  const empty = path.join(fx.base, 'staged-empty');
  fs.mkdirSync(path.join(empty, 'layers'), { recursive: true });
  const out2 = path.join(fx.base, 'no-r.json');
  r = gen(['--fixture', empty, '--methods-dir', fx.methodsDir, '--previous', out, '--manifest', out2,
    '--drop', 'fixture-b-amd64']);
  assert.equal(r.status, 0, r.stderr);
  m = JSON.parse(fs.readFileSync(out2, 'utf8'));
  assert.deepEqual(m.envs.map((e) => `${e.env_id}-${e.arch}`), ['fixture-a-amd64', 'fixture-d-arm64']);
  assert.ok(!m.bases.some((b) => b.base_id === 'base-r'), 'an unused base is left out');
  const g = guard(['--manifest', out2]);
  assert.equal(g.status, 0, `${g.stderr}\n${g.stdout}`);
  // --only at assembly takes only those ids' records.
  const both = path.join(fx.base, 'staged-both');
  stageMethodLayer(fx.base, both, fx.methodsDir, commit2, SPEC_D, RECORD_D);
  stageMethodLayer(fx.base, both, fx.methodsDir, fx.commit, SPEC_B, RECORD_B);
  stageFixtureBase(fx.base, both, 'base-py', 'arm64');
  const out3 = path.join(fx.base, 'only.json');
  r = gen(['--fixture', both, '--methods-dir', fx.methodsDir, '--previous', fx.manifestPath, '--manifest', out3]);
  assert.equal(r.status, 1, 'fixture-d-arm64 has no base in that list');
  r = gen(['--fixture', both, '--methods-dir', fx.methodsDir, '--previous', fx.manifestPath, '--manifest', out3,
    '--only', 'fixture-b']);
  assert.equal(r.status, 0, r.stderr);
  // fixture-b's record was packed again (new layer bytes): replaced.
  assert.match(r.stdout, /replaced : fixture-b-amd64/);
  assert.doesNotMatch(r.stdout, /fixture-d-arm64/);
});

// ── TEST-18: parity entry by entry ────────────────────────────────────────────

test('TEST-18a parity against the previous list: carried byte-identical, the rest re-assembled', () => {
  const fx = fixtureWithUpdate();
  const out = path.join(fx.base, 'updated.json');
  const w = gen(['--fixture', fx.one, '--methods-dir', fx.methodsDir, '--previous', fx.manifestPath, '--manifest', out]);
  assert.equal(w.status, 0, w.stderr);
  const check = (manifest, staging = fx.one) => gen(['--check', '--fixture', staging, '--methods-dir',
    fx.methodsDir, '--previous', fx.manifestPath, '--manifest', manifest]);
  let r = check(out);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /MANIFEST OK \(against the previous list .*: 1 carried byte-identical, 1 re-assembled/);
  // The whole-list mode cannot pass from a one-record dir: that is why the
  // per-entry mode exists.
  r = gen(['--check', '--fixture', fx.one, '--methods-dir', fx.methodsDir, '--manifest', out]);
  assert.equal(r.status, 1);
  // An edited carried entry is no longer carried, and has no record.
  r = check(withMutated(out, (m) => { m.envs[1].licence = 'edited'; }));
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /CHECK_NO_RECORD: envs\[1\] fixture-b-amd64 differs from the previous list at envs\[1\]\.licence/);
  // An edited re-assembled entry names its field.
  r = check(withMutated(out, (m) => { m.envs[0].size_bytes += 1; }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /MANIFEST DIFFERS at envs\[0\]\.size_bytes/);
  // A new entry without a record.
  const empty = path.join(fx.base, 'staged-empty');
  fs.mkdirSync(path.join(empty, 'layers'), { recursive: true });
  r = check(out, empty);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /CHECK_NO_RECORD: envs\[0\] fixture-a-amd64 differs from the previous list/);
  // An edited carried base.
  r = check(withMutated(out, (m) => { m.bases[0].size_bytes += 1; }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /CHECK_NO_RECORD: bases\[0\] base-py-amd64 differs from the previous list/);
  // A file that holds the same values but is not the writer's serialization.
  const reformatted = path.join(fx.base, 'reformatted.json');
  fs.writeFileSync(reformatted, JSON.stringify(JSON.parse(fs.readFileSync(out, 'utf8'))) + '\n');
  r = check(reformatted);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is not the writer's serialization/);
  // A dropped entry is printed.
  const empty2 = path.join(fx.base, 'staged-empty2');
  fs.mkdirSync(path.join(empty2, 'layers'), { recursive: true });
  const dropped = path.join(fx.base, 'dropped.json');
  assert.equal(gen(['--fixture', empty2, '--methods-dir', fx.methodsDir, '--previous', fx.manifestPath,
    '--manifest', dropped, '--drop', 'fixture-b-amd64']).status, 0);
  r = check(dropped, empty2);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /dropped from the previous list: fixture-b-amd64/);
});

test('TEST-18b entry-level parity: the named entry or base against its own record only', () => {
  const fx = fixtureWithUpdate();
  const out = path.join(fx.base, 'updated.json');
  assert.equal(gen(['--fixture', fx.one, '--methods-dir', fx.methodsDir, '--previous', fx.manifestPath,
    '--manifest', out]).status, 0);
  const check = (manifest, extra, staging = fx.one) => gen(['--check', '--fixture', staging, '--methods-dir',
    fx.methodsDir, '--manifest', manifest, ...extra]);
  let r = check(out, ['--entry', 'fixture-a-amd64']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ENTRY OK \(fixture-a-amd64 re-assembled/);
  r = check(withMutated(out, (m) => { m.envs[0].source_tree = 'f'.repeat(40); }), ['--entry', 'fixture-a-amd64']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /MANIFEST DIFFERS at envs\[0\]\.source_tree/);
  r = check(out, ['--entry', 'fixture-b-amd64']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /CHECK_NO_RECORD: fixture-b-amd64: no staged record/);
  r = check(out, ['--entry', 'fixture-z-amd64']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--entry fixture-z-amd64: the list has no such entry/);
  r = check(out, ['--entry', 'fixture-a']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is not <id>-<amd64\|arm64>/);
  // A base against its staged record (the fixture's own staging dir).
  r = check(fx.manifestPath, ['--base-entry', 'base-r-amd64'], fx.staging);
  assert.equal(r.status, 0, r.stderr);
  r = check(withMutated(fx.manifestPath, (m) => { m.bases[1].digest = 'sha256:' + '0'.repeat(64); }),
    ['--base-entry', 'base-r-amd64'], fx.staging);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /MANIFEST DIFFERS at bases\[1\]\.digest/);
  r = check(out, ['--base-entry', 'base-py-amd64']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /CHECK_NO_RECORD: base-py-amd64: no staged base/);
  // --entry and --previous together: both checks.
  r = check(out, ['--entry', 'fixture-a-amd64', '--previous', fx.manifestPath]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ENTRY OK/);
  assert.match(r.stdout, /MANIFEST OK \(against the previous list/);
});

// ── TEST-19: the facts of every entry, at its own commit ──────────────────────

test('TEST-19a the provenance check re-reads every entry\'s facts at its commit', () => {
  const fx = fixtureFull();
  const prov = (manifest, extra = []) => gen(['--check-provenance', '--manifest', manifest,
    '--methods-dir', fx.methodsDir, ...extra]);
  let r = prov(fx.manifestPath);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /provenance: OK — 3 entries/);
  // The three P7 shapes and the rest, all reported in one run.
  const bad = withMutated(fx.manifestPath, (m) => {
    m.envs[0].method_version = '2.0.1';
    m.envs[1].env_id = 'fixture-x';
    m.envs[1].method_id = 'fixture-x';
    m.envs[2].source_tree = 'f'.repeat(40);
    m.envs[2].licence = 'a paraphrase';
  });
  r = prov(bad);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /envs\[0\] fixture-a-amd64: PROVENANCE_VERSION_MISMATCH: the list says '2\.0\.1', method\.json at [0-9a-f]{12} says '2\.0\.0'/);
  assert.match(r.stderr, /envs\[1\] fixture-x-amd64: PROVENANCE_METHOD_NOT_IN_COMMIT/);
  assert.match(r.stderr, /envs\[2\] fixture-d-arm64: PROVENANCE_TREE_MISMATCH/);
  assert.match(r.stderr, /envs\[2\] fixture-d-arm64: PROVENANCE_FACT_MISMATCH: licence 'a paraphrase'/);
  assert.match(r.stderr, /FAILED — 4 problem\(s\) in 3 entries/);
  r = prov(withMutated(fx.manifestPath, (m) => { m.envs[0].source_revision = 'ffffffffffff'; }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /PROVENANCE_COMMIT_UNKNOWN/);
  r = prov(withMutated(fx.manifestPath, (m) => { m.envs[0].wrapper_code_sha256 = 'e'.repeat(64); }));
  assert.match(r.stderr, /PROVENANCE_WRAPPER_MISMATCH/);
  // --entry narrows the check.
  r = prov(bad, ['--entry', 'fixture-b-amd64']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the list has no such entry/);
  r = prov(withMutated(fx.manifestPath, (m) => { m.envs[0].licence = 'x'; }), ['--entry', 'fixture-b-amd64']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /provenance: OK — 1 entry/);
});

test('TEST-19b the guard\'s provenance leg runs with the methods repository, skips without it', () => {
  const fx = fixture();
  let r = guard(['--manifest', fx.manifestPath, '--methods-dir', fx.methodsDir]);
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.match(r.stdout, /provenance: OK — 2 entries/);
  r = guard(['--manifest', withMutated(fx.manifestPath, (m) => { m.envs[0].licence = 'edited'; }),
    '--methods-dir', fx.methodsDir]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /PROVENANCE_FACT_MISMATCH: licence 'edited'/);
  r = guard(['--manifest', fx.manifestPath]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /provenance SKIPPED — no methods repository/);
  r = guard(['--manifest', fx.manifestPath, '--require-provenance']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--require-provenance/);
  // The parity modes are wired through: incremental, and entry by entry.
  const up = fixtureWithUpdate();
  const out = path.join(up.base, 'updated.json');
  assert.equal(gen(['--fixture', up.one, '--methods-dir', up.methodsDir, '--previous', up.manifestPath,
    '--manifest', out]).status, 0);
  r = guard(['--manifest', out, '--staging-dir', up.one, '--methods-dir', up.methodsDir,
    '--previous', up.manifestPath, '--entry', 'fixture-a-amd64']);
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.match(r.stdout, /regen parity \(against /);
  assert.match(r.stdout, /ENTRY OK/);
  assert.match(r.stdout, /provenance: OK — 1 entry/);
  r = guard(['--manifest', out, '--staging-dir', up.one, '--methods-dir', up.methodsDir]);
  assert.equal(r.status, 1, 'the whole-list mode needs every record');
  r = guard(['--manifest', out, '--previous', up.manifestPath]);
  assert.equal(r.status, 2, 'a parity mode needs a staging dir');
});

// ── TEST-20: the schema 2 shape in the guard ──────────────────────────────────

test('TEST-20 the guard refuses a list without well-formed per-entry provenance', () => {
  const { manifestPath } = fixture();
  const cases = [
    ['a missing source_revision', (m) => { delete m.envs[0].source_revision; }, /missing required property 'source_revision'/],
    ['a missing source_tree', (m) => { delete m.envs[0].source_tree; }, /missing required property 'source_tree'/],
    ['a missing generator_version', (m) => { delete m.envs[0].generator_version; },
      /missing required property 'generator_version'/],
    ['an uppercase revision', (m) => { m.envs[0].source_revision = m.envs[0].source_revision.toUpperCase(); },
      /source_revision/],
    ['a short tree', (m) => { m.envs[0].source_tree = 'abc123'; }, /source_tree/],
    ['a generator version that is not X.Y.Z', (m) => { m.envs[0].generator_version = '0.5'; }, /generator_version/],
    ['a top-level source_revision (schema 1)', (m) => { m.source_revision = '0123456789ab'; },
      /additional property 'source_revision'/],
    ['schema_version 1', (m) => { m.schema_version = 1; }, /schema_version: must be exactly 2/],
    ['a + in the version (FOLLOW-UPS 72)', (m) => {
      m.envs[0].method_version = '2.0.0+build1';
      m.envs[0].tag = `fixture-a-2.0.0+build1-amd64-${m.envs[0].layer_sha256.slice(0, 12)}`;
    }, /method_version: '2\.0\.0\+build1' does not match/],
  ];
  for (const [what, mutate, re] of cases) {
    const r = guard(['--manifest', withMutated(manifestPath, mutate)]);
    assert.equal(r.status, 1, `${what} must be refused: ${r.stdout}`);
    assert.match(r.stderr, re, `${what}: ${r.stderr}`);
  }
});

// ── TEST-21: the publisher checks the entry it publishes (D4) ─────────────────

test('TEST-21a the publisher publishes one method from a dir holding only its record', () => {
  const fx = fixtureWithUpdate();
  const out = path.join(fx.base, 'updated.json');
  assert.equal(gen(['--fixture', fx.one, '--methods-dir', fx.methodsDir, '--previous', fx.manifestPath,
    '--manifest', out]).status, 0);
  const args = (extra) => ['--env', 'fixture-a', '--dry-run', '--manifest', out, '--staging-dir', fx.one,
    '--methods-dir', fx.methodsDir, ...extra];
  let r = publisher(args(['--previous', fx.manifestPath]));
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.match(r.stdout, /\+ scripts\/check-method-env-images\.sh .*--previous .* --entry fixture-a-amd64/);
  assert.match(r.stdout, /guard {5}: manifest \+ per-entry parity \(vs .*\) \+ provenance OK/);
  assert.match(r.stdout, /revision {2}: [0-9a-f]{12} tree [0-9a-f]{40}/);
  // The whole-list mode (no --previous) needs every record: refused here.
  r = publisher(args([]));
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /check-method-env-images\.sh rejects the manifest/);
  // A carried entry another commit changed is not re-assembled from this dir:
  // an edit to fixture-b fails the per-entry check of fixture-a's publish.
  const edited = withMutated(out, (m) => { m.envs[1].licence = 'edited'; });
  r = publisher(['--env', 'fixture-a', '--dry-run', '--manifest', edited, '--staging-dir', fx.one,
    '--methods-dir', fx.methodsDir, '--previous', fx.manifestPath]);
  assert.equal(r.status, 1, r.stdout);
  // --previous names a file; the methods repository is required.
  r = publisher(args(['--previous', path.join(fx.base, 'none.json')]));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--previous .*: no such file/);
  r = publisher(['--env', 'fixture-a', '--dry-run', '--manifest', out, '--staging-dir', fx.one]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--methods-dir <the methods repository> is required/);
});

test('TEST-21b the publisher refuses a record whose provenance is not the entry\'s', () => {
  const cases = [
    ['another commit', { source_revision: 'ffffffffffff' }, /record source_revision ffffffffffff != entry/],
    ['another tree', { source_tree: 'f'.repeat(40) }, /record source_tree f{40} != entry/],
    ['another generator', { generator_version: '9.9.9' }, /record generator_version 9\.9\.9 != entry 0\.5\.0/],
  ];
  for (const [what, fields, re] of cases) {
    const fx = fixture();
    editRecord(path.join(fx.staging, 'layers', 'fixture-a-amd64', 'artifact.json'), fields);
    const r = publisher(['--env', 'fixture-a', '--dry-run', '--manifest', fx.manifestPath,
      '--staging-dir', fx.staging, '--methods-dir', fx.methodsDir]);
    assert.equal(r.status, 1, `${what}: ${r.stdout}`);
    assert.match(r.stderr, re, `${what}: ${r.stderr}`);
  }
  // A legacy record (record_schema_version 1, no tree) is accepted and said so.
  const fx = fixture();
  const p = path.join(fx.staging, 'layers', 'fixture-a-amd64', 'artifact.json');
  const rec = JSON.parse(fs.readFileSync(p, 'utf8'));
  delete rec.source_tree;
  fs.writeFileSync(p, JSON.stringify({ ...rec, record_schema_version: 1 }, null, 2));
  const r = publisher(['--env', 'fixture-a', '--dry-run', '--manifest', fx.manifestPath,
    '--staging-dir', fx.staging, '--methods-dir', fx.methodsDir]);
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.match(r.stdout, /record {4}: legacy record \(record_schema_version 1, no tree recorded\)/);
});

// ── TEST-22: reproducible layers (one layer file = one artifact) ──────────────

const LAYER_PACK_HARNESS = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("txr_generator", sys.argv[1])
g = importlib.util.module_from_spec(spec)
sys.modules["txr_generator"] = g
spec.loader.exec_module(g)
g.pack_layer(sys.argv[2], sys.argv[3])
print(json.dumps({"sha": g._sha256_of(sys.argv[3])}))
`;

/** The pinned layer construction (design §6.1), spelled independently of the
 *  generator so a drift on either side shows. */
function expectedLayerOciBytes(rec, contract) {
  return JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    artifactType: 'application/vnd.txr.method-env.layer.v1',
    config: {
      mediaType: 'application/vnd.oci.empty.v1+json',
      digest: 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
      size: 2,
    },
    layers: [{
      mediaType: 'application/vnd.txr.method-env.layer.v1',
      digest: 'sha256:' + rec.layer_sha256,
      size: rec.size_bytes,
      annotations: { 'org.opencontainers.image.title': 'layer.squashfs' },
    }],
    annotations: {
      'org.opencontainers.image.source': 'https://github.com/tinnlab/txresbench-methods',
      'com.txr.method_id': rec.method_id,
      'com.txr.method_version': rec.method_version,
      'com.txr.language': rec.language,
      'com.txr.arch': rec.arch,
      'com.txr.contract': contract,
      'com.txr.layer_sha256': rec.layer_sha256,
      'com.txr.layer_schema': String(rec.layer_schema),
    },
  });
}

test('TEST-22a one layer root packs to the same bytes every time', () => {
  if (!(haveTool('mksquashfs') && haveTool('unsquashfs'))) {
    assert.fail('TEST-22a needs mksquashfs + unsquashfs on PATH (squashfs-tools)');
  }
  const dir = mkdtemp('mei-layerpack-');
  const root = path.join(dir, 'root');
  writeLayerRoot(root, SPEC_A);
  const one = harness(LAYER_PACK_HARNESS, [root, path.join(dir, 'one.squashfs')]);
  // New file times (another extraction, another machine's clock) must not
  // change a byte; nor a copy of the same tree elsewhere.
  const later = new Date(Date.now() + 7200 * 1000);
  fs.utimesSync(path.join(root, 'code', 'run.py'), later, later);
  fs.utimesSync(path.join(root, 'code'), later, later);
  const two = harness(LAYER_PACK_HARNESS, [root, path.join(dir, 'two.squashfs')]);
  const copy = path.join(dir, 'copy');
  writeLayerRoot(copy, SPEC_A);
  const three = harness(LAYER_PACK_HARNESS, [copy, path.join(dir, 'three.squashfs')]);
  assert.equal(two.sha, one.sha, 'deterministic pack');
  assert.equal(three.sha, one.sha, 'the same tree packs to the same file');
  assert.equal(createHash('sha256').update(fs.readFileSync(path.join(dir, 'two.squashfs'))).digest('hex'), two.sha);
  // A different tree is a different file.
  const other = path.join(dir, 'other');
  writeLayerRoot(other, { ...SPEC_A, runExtra: '# changed\n' });
  assert.notEqual(harness(LAYER_PACK_HARNESS, [other, path.join(dir, 'other.squashfs')]).sha, one.sha);
});

test('TEST-22b the same layer file at a later commit or on a new base keeps its digest and tag', () => {
  const fx = fixture();
  const prev = JSON.parse(fs.readFileSync(fx.manifestPath, 'utf8'));
  const a = prev.envs[0];
  const rec = JSON.parse(fs.readFileSync(path.join(fx.staging, 'layers', 'fixture-a-amd64', 'artifact.json'), 'utf8'));
  // The pinned construction: the layer and its file, no commit, no base.
  const oci = fs.readFileSync(path.join(fx.staging, 'layers', 'fixture-a-amd64', 'oci-manifest.json'), 'utf8');
  assert.equal(oci, expectedLayerOciBytes(rec, '2.0'));
  assert.doesNotMatch(oci, /image\.revision|com\.txr\.base_/);
  assert.equal(a.digest, 'sha256:' + createHash('sha256').update(oci).digest('hex'));
  // Another method changes; fixture-a's folder does not. Its same layer file,
  // recorded again at the later commit and over a new base image (a base
  // batch), is the same artifact: same digest, same tag.
  writeMethodFolder(fx.methodsDir, { ...SPEC_B, runExtra: '# b changed\n' });
  const commit2 = commitAll(fx.methodsDir, 'fixture-b changed');
  const NEW = 'sha256:' + 'ef'.repeat(32);
  const again = path.join(fx.base, 'staged-again');
  fs.mkdirSync(path.join(again, 'layers'), { recursive: true });
  fs.cpSync(path.join(fx.staging, 'layers', 'fixture-a-amd64'), path.join(again, 'layers', 'fixture-a-amd64'),
    { recursive: true });
  fs.rmSync(path.join(again, 'layers', 'fixture-a-amd64', 'oci-manifest.json'));
  editRecord(path.join(again, 'layers', 'fixture-a-amd64', 'artifact.json'), {
    source_revision: commit2.slice(0, 12), base_digest: NEW,
  });
  stageFixtureBase(fx.base, again, 'base-py', 'amd64', { source_digest: NEW });
  const out = path.join(fx.base, 'again.json');
  const r = gen(['--fixture', again, '--methods-dir', fx.methodsDir, '--previous', fx.manifestPath,
    '--manifest', out, '--replace-base', 'base-py-amd64']);
  assert.equal(r.status, 0, r.stderr);
  const a2 = JSON.parse(fs.readFileSync(out, 'utf8')).envs[0];
  assert.equal(a2.digest, a.digest, 'the same artifact');
  assert.equal(a2.tag, a.tag);
  assert.equal(a2.layer_sha256, a.layer_sha256);
  assert.equal(a2.source_revision, commit2.slice(0, 12), 'the list records the new build');
  assert.equal(a2.source_tree, a.source_tree, 'the folder did not change');
  assert.equal(a2.base_digest, NEW);
  assert.equal(fs.readFileSync(path.join(again, 'layers', 'fixture-a-amd64', 'oci-manifest.json'), 'utf8'), oci,
    'the staged OCI bytes are the published ones');
});

// ── TEST-23: the trim (design §4) ─────────────────────────────────────────────
// The generator's own trim_delta + trim_layer, imported by path, over one
// small layer root: the delta trim sees every file as added, the layer trim
// runs on the tree. Both must keep the same files.
const TRIM_HARNESS = `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("txr_generator", sys.argv[1])
g = importlib.util.module_from_spec(spec)
sys.modules["txr_generator"] = g
spec.loader.exec_module(g)
root = sys.argv[2]
def files():
    out = []
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            out.append(os.path.relpath(os.path.join(dirpath, name), root).replace(os.sep, "/"))
    return sorted(out)
delta = g.Delta()
delta.added = {p: "file" for p in files()}
by_delta = sorted(g.trim_delta(delta).added)
g.trim_layer(root)
print(json.dumps({"layer": files(), "delta": by_delta}))
`;

const SITE = 'opt/txr-layer/lib/python3.11/site-packages';

/** Kept by the trim: TensorFlow's import-time packages and ordinary files. */
const TRIM_KEPT = [
  `${SITE}/tensorflow/tools/docs/__init__.py`,
  `${SITE}/tensorflow/tools/docs/doc_controls.py`,
  `${SITE}/tensorflow/_api/v2/test/__init__.py`,
  `${SITE}/tensorflow/_api/v2/test/experimental/__init__.py`,
  `${SITE}/tensorflow/_api/v2/__internal__/test/__init__.py`,
  `${SITE}/tensorflow/_api/v2/compat/v1/test/__init__.py`,
  `${SITE}/tensorflow/python/util/deprecation.py`,
  `${SITE}/joblib/parallel.py`,
  'opt/txr-layer/R-library/survival/R/survival',
  'code/run.py',
];

/** Removed by the trim, before and after the change. */
const TRIM_REMOVED = [
  // bytecode inside a kept package dir
  `${SITE}/tensorflow/tools/docs/__pycache__/doc_controls.cpython-311.pyc`,
  `${SITE}/tensorflow/_api/v2/test/__init__.pyc`,
  // TensorFlow dirs outside the kept paths
  `${SITE}/tensorflow/include/tensorflow/core/framework/tensor.h`,
  `${SITE}/tensorflow/python/compiler/tensorrt/test/__init__.py`,
  `${SITE}/tensorflow/dtensor/python/tests/__init__.py`,
  // Python packages named test, tests, docs, examples
  `${SITE}/joblib/test/__init__.py`,
  `${SITE}/joblib/test/test_parallel.py`,
  `${SITE}/fixturepkg/tests/__init__.py`,
  `${SITE}/fixturepkg/docs/__init__.py`,
  `${SITE}/fixturepkg/examples/__init__.py`,
  `${SITE}/fixturepkg/doc/notes.txt`,
  `${SITE}/fixturepkg/include/fixture.h`,
  `${SITE}/fixturepkg/lib/libfixture.a`,
  // the kept paths only count right below a site-packages dir
  `${SITE}/tensorflowx/tools/docs/__init__.py`,
  `${SITE}/vendored/tensorflow/tools/docs/__init__.py`,
  'opt/txr-layer/share/tensorflow/tools/docs/__init__.py',
  // R package dirs
  'opt/txr-layer/R-library/survival/doc/survival.pdf',
  'opt/txr-layer/R-library/survival/tests/test.R',
  'opt/txr-layer/R-library/Rcpp/include/Rcpp.h',
];

function trim() {
  const root = path.join(mkdtemp('txr-trim-'), 'layer');
  for (const rel of [...TRIM_KEPT, ...TRIM_REMOVED]) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), `${rel}\n`);
  }
  const r = spawnSync('python3', ['-c', TRIM_HARNESS, GENERATOR, root], { encoding: 'utf8' });
  assert.equal(r.status, 0, `the harness itself must run: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

test('TEST-23a the trim keeps the packages named docs and test that import tensorflow loads', () => {
  const { layer, delta } = trim();
  for (const rel of TRIM_KEPT) {
    assert.ok(layer.includes(rel), `the layer trim must keep ${rel}`);
    assert.ok(delta.includes(rel), `the delta trim must keep ${rel}`);
  }
  assert.deepEqual(layer, [...TRIM_KEPT].sort(), 'the layer keeps exactly the kept files');
});

test('TEST-23b the trim still removes every other trim-named dir, packages named test or docs included', () => {
  const { layer, delta } = trim();
  for (const rel of TRIM_REMOVED) {
    assert.ok(!layer.includes(rel), `the layer trim must remove ${rel}`);
    assert.ok(!delta.includes(rel), `the delta trim must remove ${rel}`);
  }
  assert.deepEqual(delta, layer, 'the delta trim and the layer trim keep the same files');
});

// ── TEST-24: -processors on every mksquashfs pack ─────────────────────────────
// mksquashfs sizes its thread pool from the machine's CPU count (192 here),
// not the CPUs this process may use — so the generator passes `-processors N`
// per pack call (never folded into the flag constants), and the image bytes
// must not change with the thread count.

const SQUASHFS_PROCESSORS_HARNESS = `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("txr_generator", sys.argv[1])
g = importlib.util.module_from_spec(spec)
sys.modules["txr_generator"] = g
spec.loader.exec_module(g)
calls = []
def fake_run(cmd, **kw):
    # pack_base os.replace()s its tmp over the out path: materialize the tmp.
    if cmd[0] == "mksquashfs" and cmd[2].endswith(".tmp"):
        os.makedirs(os.path.dirname(cmd[2]), exist_ok=True)
        with open(cmd[2], "w") as f:
            f.write("fixture")
    calls.append(cmd)
g._run = fake_run
g._assert_squashfs_ok = lambda p: None
n = g._squashfs_processors()
root, staging = sys.argv[2], sys.argv[3]
g.pack_layer(root, os.path.join(staging, "layer.squashfs"))
# The base rootfs needs what base_rootfs_problems() checks.
os.makedirs(os.path.join(root, "opt", "txr-layer"), exist_ok=True)
os.makedirs(os.path.join(root, "usr", "bin"), exist_ok=True)
open(os.path.join(root, "usr", "bin", "prlimit"), "w").close()
open(os.path.join(root, "usr", "bin", "bash"), "w").close()
g.pack_base(root, os.path.join(staging, "bases", "base-py-amd64"),
            base_id="base-py", arch="amd64",
            source_ref="ghcr.io/tinnlab/txresbench-base-py:2.0",
            source_digest="sha256:" + "ab" * 32,
            source_ref_source="local", source_digest_source="repo_digests")
print(json.dumps({"affinity": len(os.sched_getaffinity(0)), "n": n,
                  "calls": calls,
                  "layer_flags": list(g.LAYER_MKSQUASHFS_FLAGS),
                  "base_flags": list(g.BASE_MKSQUASHFS_FLAGS)}))
`;

test('TEST-24a the pack command lines carry -processors after the flags', () => {
  const dir = mkdtemp('mei-proc-');
  const root = path.join(dir, 'root');
  fs.mkdirSync(path.join(root, 'code'), { recursive: true });
  fs.writeFileSync(path.join(root, 'code', 'run.sh'), '#!/bin/sh\n');
  const r = spawnSync('python3', ['-c', SQUASHFS_PROCESSORS_HARNESS, GENERATOR, root, dir],
    { encoding: 'utf8' });
  assert.equal(r.status, 0, `the harness itself must run: ${r.stderr}`);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.n, out.affinity,
    '-processors is len(os.sched_getaffinity(0)) (fallback os.cpu_count() or 1)');
  assert.ok(out.n >= 1, 'the helper never returns fewer than one processor');
  assert.equal(out.calls.length, 2, 'one _run per pack (layer + base)');
  for (const cmd of out.calls) {
    assert.equal(cmd[0], 'mksquashfs');
    const i = cmd.indexOf('-processors');
    assert.ok(i !== -1, `${cmd.join(' ')} must carry -processors`);
    assert.equal(cmd[i + 1], String(out.n));
    assert.ok(i > 2, `-processors must come AFTER the source/out and the flags: ${cmd.join(' ')}`);
  }
  // The flag constants stay the pinned recipe; -processors is per-call only.
  for (const flags of [out.layer_flags, out.base_flags]) {
    assert.ok(!flags.includes('-processors'), 'the flag constants never hold -processors');
  }
});

const MKSQUASHFS_FLAGS_HARNESS = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("txr_generator", sys.argv[1])
g = importlib.util.module_from_spec(spec)
sys.modules["txr_generator"] = g
spec.loader.exec_module(g)
print(json.dumps(list(g.LAYER_MKSQUASHFS_FLAGS)))
`;

test('TEST-24b -processors does not change a byte of the packed image', () => {
  if (!haveTool('mksquashfs')) {
    assert.fail('TEST-24b needs mksquashfs on PATH (squashfs-tools) to prove the byte identity');
  }
  const dir = mkdtemp('mei-procid-');
  const root = path.join(dir, 'root');
  writeLayerRoot(root, SPEC_A);
  // Several multi-block files (1 MB blocks), so 1 and 4 threads really split the work.
  for (let i = 0; i < 4; i++) {
    const big = Buffer.alloc(3 * 1024 * 1024 + 17);
    for (let j = 0; j < big.length; j++) big[j] = (j * 31 + i * 7 + (j >> 12)) & 0xff;
    fs.writeFileSync(path.join(root, `big-${i}.bin`), big);
  }
  const r = spawnSync('python3', ['-c', MKSQUASHFS_FLAGS_HARNESS, GENERATOR], { encoding: 'utf8' });
  assert.equal(r.status, 0, `the flag harness itself must run: ${r.stderr}`);
  const flags = JSON.parse(r.stdout.trim().split('\n').pop());
  const one = path.join(dir, 'one.squashfs');
  const four = path.join(dir, 'four.squashfs');
  for (const [out, n] of [[one, '1'], [four, '4']]) {
    const p = spawnSync('mksquashfs', [root, out, ...flags, '-processors', n], { encoding: 'utf8' });
    assert.equal(p.status, 0, `mksquashfs -processors ${n} failed: ${p.stderr}\n${p.stdout}`);
  }
  assert.ok(fs.readFileSync(one).equals(fs.readFileSync(four)),
    'the image bytes must not change with -processors (1 vs 4)');
});
