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
//            sequence (login → blob/manifest push → resolve → sign) — each
//            driven against a stub `oras`/`cosign` on PATH, never a network.
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
//            oras call is plain HTTP to that host with no login and no cosign
//            (stub oras/cosign, no network).
//   TEST-12  the layer cover (`closed_cover`) on small base/method trees: a
//            method's Python and R packages under /opt/txr-layer are the ONE
//            entry /opt/txr-layer (beside /code), including a package the base
//            also has; a new package dir in the base's own library and a new
//            /opt folder are refused at build time, naming the path (the base's
//            /usr and /opt are read-only in the sandbox, so no mount point could
//            be made for them); a changed file the base already has stays an
//            entry; a code-only method is just /code.
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
// A fixture methods tree + staged artifact records, written by hand in the
// exact `artifact.json` shape ITEM-2's build produces (the ITEM-3 fixture
// shape), then a manifest produced by the generator's own `--fixture` mode.
const REVISION = '0123456789ab';
const RECORD_A = {
  record_schema_version: 1,
  generator_version: '0.2.0',
  env_id: 'fixture-a',
  method_id: 'fixture-a',
  method_version: '2.0.0',
  language: 'Python',
  arch: 'amd64',
  oci_ref: 'ghcr.io/tinnlab/txr-method-env-layers/fixture-a',
  tag: '2.0.0-amd64',
  source_revision: REVISION,
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
  oci_ref: 'ghcr.io/tinnlab/txr-method-env-layers/fixture-b',
  base_ref: 'ghcr.io/tinnlab/txresbench-base-r:2.0',
  layer_sha256: 'a07cd921df4d1ed80a6d0190210cedbfc4d6e09aaf433947b28e3f8f972057ea',
  wrapper_code_sha256: 'be460acb0ede00fcef1f12b19d837048ab4648d0d6f2920677be2b667a4233fb',
  run_file: 'run.R',
};
const INDEX = {
  index_version: '2026.10.0',
  contract_versions: ['2.0'],
  methods: [
    { id: 'fixture-a', version: '2.0.0', language: 'Python', contract: '2.0', runnable: true },
    { id: 'fixture-b', version: '2.0.0', language: 'R', contract: '2.0', runnable: true },
    { id: 'fixture-c', version: '1.0.0', language: 'Python', contract: '2.0', runnable: false },
  ],
};

/** methodsDir + stagingDir with two staged records; the manifest is written by
 *  the real generator's --fixture mode and returned as its path.
 *
 *  The staged layer.squashfs is a REAL squashfs (mksquashfs over a fixture
 *  layer root carrying the schema marker, /code payload and the bind
 *  manifest), and the record's `layer_sha256`/`size_bytes`/`wrapper_code_sha256`
 *  are set to THEIR REAL values — the generator's --fixture mode trusts the
 *  record, but the publisher (ITEM-5) re-hashes the staged file and ITEM-7's
 *  behavioral verifier EXTRACTS it, so the fixture byte contract must be
 *  truthful for the publisher / verifier to be the thing under test. */
function writeLayerRoot(root, { id, licence, run, language, withRun = true }) {
  fs.mkdirSync(path.join(root, 'code'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'code', 'method.json'),
    JSON.stringify({ id, licence, language }),
  );
  if (withRun) {
    fs.writeFileSync(
      path.join(root, 'code', run),
      `#!/usr/bin/env ${run === 'run.py' ? 'python3' : 'Rscript'}\n# fixture wrapper\n`,
    );
  }
  fs.writeFileSync(path.join(root, '.txr-method-env-layer-schema'), '1');
  fs.writeFileSync(path.join(root, 'layer-manifest.json'), JSON.stringify(['/code']));
  // The root-level usr/ sentinel (design §5): the runtime's shared mount
  // readiness probe is `usr/ present == mounted` for every artifact; the
  // generator emits it, and the fixture layers must carry it too.
  fs.mkdirSync(path.join(root, 'usr'));
}

/** mksquashfs a fixture layer root (the ARTIFACT shape, host tool). */
function squashLayer(root, out) {
  const r = spawnSync('mksquashfs', [
    root, out, '-comp', 'zstd', '-b', '1M', '-noappend', '-no-progress', '-all-root',
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
  fs.writeFileSync(path.join(dir, 'artifact.json'), JSON.stringify({
    ...rec,
    layer_sha256: createHash('sha256').update(bytes).digest('hex'),
    size_bytes: bytes.length,
    wrapper_code_sha256: wrapper,
  }, null, 2));
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

/** A tiny base root holding what the stacked run needs: the layer mount
 *  point (+ the R library for base-r), prlimit and bash through the Debian
 *  `bin -> usr/bin` link. `omit` drops paths; `binLink` sets the link. */
function writeBaseRoot(root, baseId, { omit = [], binLink = 'usr/bin' } = {}) {
  const files = {
    'opt/txr-layer/': null,
    'usr/bin/prlimit': '#!/bin/sh\n',
    'usr/bin/bash': '#!/bin/sh\n',
  };
  if (baseId === 'base-r') files['opt/txr-layer/R-library/'] = null;
  for (const rel of omit) delete files[rel];
  writeTree(root, files);
  fs.mkdirSync(path.join(root, 'usr', 'bin'), { recursive: true });
  fs.symlinkSync(binLink, path.join(root, 'bin'));
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
    oci_ref: `ghcr.io/tinnlab/txresbench-env/${baseId}`,
    tag: `2.0-${arch}-${sha.slice(0, 12)}`,
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

function stageFixtureBase(base, staging, baseId, arch) {
  const root = path.join(base, `${baseId}-${arch}-root`);
  writeBaseRoot(root, baseId);
  return stagedBaseRecord(staging, baseId, arch, root);
}

function fixture() {
  const base = mkdtemp('mei-fixture-');
  const methodsDir = path.join(base, 'methods');
  const staging = path.join(base, 'staged');
  const manifestPath = path.join(base, 'manifest.json');
  const spec = [
    ['fixture-a', 'Python', 'run.py', RECORD_A],
    ['fixture-b', 'R', 'run.R', RECORD_B],
  ];
  for (const [id, language, run] of spec) {
    const d = path.join(methodsDir, 'methods', id);
    fs.mkdirSync(d, { recursive: true });
    const licence = `verbatim-licence-of-${id}-LLC`;
    fs.writeFileSync(
      path.join(d, 'method.json'),
      JSON.stringify({ id, licence, language }),
    );
    const dir = path.join(staging, 'layers', `${id}-amd64`);
    fs.mkdirSync(dir, { recursive: true });
    const root = path.join(base, `${id}-root`);
    writeLayerRoot(root, { id, licence, run, language });
    stagedLayerRecord(dir, id === 'fixture-a' ? RECORD_A : RECORD_B, root, run);
  }
  fs.writeFileSync(path.join(methodsDir, 'index.json'), JSON.stringify(INDEX));
  // The bases the two amd64 layers stack on (fixture-a Python, fixture-b R).
  stageFixtureBase(base, staging, 'base-py', 'amd64');
  stageFixtureBase(base, staging, 'base-r', 'amd64');
  const r = gen(['--fixture', staging, '--methods-dir', methodsDir, '--manifest', manifestPath]);
  assert.equal(r.status, 0, `fixture manifest did not assemble: ${r.stderr}`);
  return { base, methodsDir, staging, manifestPath };
}

// ── ITEM-6 fixture: the FULL-GENERATION shape ─────────────────────────────────
// The plan's ITEM-6 is the real 95-method run; TEST-10/TEST-11 pin its
// GENERATED-MANIFEST properties on the fixture index: one entry per runnable
// method per published arch (here amd64 + a native arm64 record share one env
// id), per-arch tags `^<version>-(amd64|arm64)$`, and the full provenance
// triplet + the verbatim licence (INV-6/TEST-11).
const RECORD_D = {
  ...RECORD_A,
  env_id: 'fixture-d',
  method_id: 'fixture-d',
  method_version: '1.5.0',
  arch: 'arm64',
  oci_ref: 'ghcr.io/tinnlab/txr-method-env-layers/fixture-d',
  tag: '1.5.0-arm64',
  wrapper_code_sha256: 'c4f0c7861fd6f6d66b2a90c8e35fc787a49e85bfef2c35d7b7270fd5c89cda25',
};
const INDEX_FULL = {
  index_version: '2026.10.0',
  contract_versions: ['2.0'],
  methods: [
    ...INDEX.methods,
    { id: 'fixture-d', version: '1.5.0', language: 'Python', contract: '2.0', runnable: true },
  ],
};

/** The ITEM-6 fixture: three staged records (a amd64, b amd64, d arm64) over an
 *  index with two runnable fixtures + one non-runnable (fixture-c) + one arm64
 *  fixture (fixture-d); the manifest is written by the real generator. */
function fixtureFull() {
  const { base, methodsDir, staging } = fixture();
  const manifestPath = path.join(base, 'manifest-full.json');
  fs.writeFileSync(path.join(methodsDir, 'index.json'), JSON.stringify(INDEX_FULL));
  const dMethods = path.join(methodsDir, 'methods', 'fixture-d');
  fs.mkdirSync(dMethods, { recursive: true });
  const dLicence = 'verbatim-licence-of-fixture-d-LLC';
  fs.writeFileSync(
    path.join(dMethods, 'method.json'),
    JSON.stringify({ id: 'fixture-d', licence: dLicence, language: 'Python' }),
  );
  const dir = path.join(staging, 'layers', 'fixture-d-arm64');
  fs.mkdirSync(dir, { recursive: true });
  const dRoot = path.join(base, 'fixture-d-root');
  writeLayerRoot(dRoot, { id: 'fixture-d', licence: dLicence, run: 'run.py', language: 'Python' });
  stagedLayerRecord(dir, RECORD_D, dRoot, 'run.py');
  stageFixtureBase(base, staging, 'base-py', 'arm64');
  const r = gen(['--fixture', staging, '--methods-dir', methodsDir, '--manifest', manifestPath]);
  assert.equal(r.status, 0, `ITEM-6 fixture manifest did not assemble: ${r.stderr}`);
  return { base, methodsDir, staging, manifestPath };
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

test('TEST-2c parity fails naming source_revision after a bumped revision', () => {
  const { staging, methodsDir, manifestPath } = fixture();
  const p = withMutated(manifestPath, (m) => { m.source_revision = 'ffffffffffff'; });
  const r = gen(['--check', '--fixture', staging, '--methods-dir', methodsDir, '--manifest', p]);
  assert.equal(r.status, 1, 'a bumped revision must fail parity');
  assert.match(r.stderr, /source_revision/);
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
// registry is never contacted: the artifact checks, the guard preflight and
// the refusal paths are all local, and the stubbed success path witnesses the
// exact push sequence without a network.
function publisher(args = [], env = {}) {
  return spawnSync('bash', [PUBLISHER, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

/** Write the stub tool dir. `resolveDigest` is what `oras resolve` answers,
 *  unless `resolveMap` names the resolved ref (its last argument): then the
 *  map's digest is the answer (an empty string = the tag is absent). Returns
 *  { dir, bin, log, env } where env carries the PATH + the stub's log path.
 *  The returned `dir` is the ONLY thing the caller may clean up. */
function makeStubs(resolveDigest, resolveMap = {}) {
  const dir = mkdtemp('mei-pubstub-');
  const log = path.join(dir, 'calls.log');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const mapFile = path.join(dir, 'resolve.map');
  fs.writeFileSync(mapFile, Object.entries(resolveMap).map(([ref, d]) => `${ref} ${d}\n`).join(''));
  fs.writeFileSync(path.join(bin, 'oras'), `#!/usr/bin/env sh
echo "oras $*" >> "$ORAS_STUB_LOG"
case "$1" in
  login) cat >/dev/null ;;
  resolve)
    for a in "$@"; do ref="$a"; done
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
    ORAS_STUB_RESOLVE: resolveDigest,
    ORAS_STUB_RESOLVE_MAP: mapFile,
    PATH: `${bin}:${process.env.PATH}`,
  };
  return { dir, bin, log, env };
}

function calls(log) {
  return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
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
  const { dir: stubDir, log, env } = makeStubs(entry.digest, { [baseRef]: pyBase.digest });
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
  assert.deepEqual(c, [
    `oras login ghcr.io -u stub-user --password-stdin`,
    `oras resolve ghcr.io/tinnlab/txr-method-env-layers/fixture-a:${entry.tag}`,
    `oras resolve ${baseRef}`,
    `oras blob push ghcr.io/tinnlab/txr-method-env-layers/fixture-a layer.squashfs`,
    `oras blob push ghcr.io/tinnlab/txr-method-env-layers/fixture-a ${path.join(staging, 'publish', 'empty-config.json')}`,
    `oras manifest push ghcr.io/tinnlab/txr-method-env-layers/fixture-a:${entry.tag} ${path.join(staging, 'layers', 'fixture-a-amd64', 'oci-manifest.json')}`,
    `oras resolve ghcr.io/tinnlab/txr-method-env-layers/fixture-a:${entry.tag}`,
    `cosign sign --yes ghcr.io/tinnlab/txr-method-env-layers/fixture-a@${entry.digest}`,
  ], `the publish sequence must be login → resolve → base resolve → blob → blob → manifest → resolve → sign:\n${c.join('\n')}`);
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
  const idx = JSON.parse(fs.readFileSync(path.join(methodsDir, 'index.json'), 'utf8'));
  const runnable = idx.methods.filter((e) => e.runnable === true).map((e) => e.id).sort();
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
    assert.match(e.tag, new RegExp(`^${e.method_version}-(amd64|arm64)$`),
      `${e.env_id}: per-arch tag <version>-<arch> (DEC-2), got ${e.tag}`);
  }
  const d = m.envs.find((e) => e.env_id === 'fixture-d');
  assert.equal(d.arch, 'arm64');
  assert.equal(d.tag, '1.5.0-arm64');
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
  const cDir = path.join(staging, 'layers', 'fixture-c-amd64');
  fs.mkdirSync(cDir, { recursive: true });
  const cBytes = Buffer.alloc(1024, 5);
  fs.writeFileSync(path.join(cDir, 'layer.squashfs'), cBytes);
  fs.writeFileSync(path.join(cDir, 'artifact.json'), JSON.stringify({
    ...RECORD_A,
    env_id: 'fixture-c',
    method_id: 'fixture-c',
    method_version: '1.0.0',
    oci_ref: 'ghcr.io/tinnlab/txr-method-env-layers/fixture-c',
    tag: '1.0.0-amd64',
    layer_sha256: createHash('sha256').update(cBytes).digest('hex'),
    size_bytes: cBytes.length,
  }, null, 2));
  const r = gen(['--fixture', staging, '--methods-dir', methodsDir,
    '--manifest', path.join(path.dirname(manifestPath), 'manifest-must-not-write.json')]);
  assert.notEqual(r.status, 0, 'a record for a non-runnable method must refuse');
  assert.match(r.stderr, /fixture-c/);
  assert.match(r.stderr, /not runnable/);
});

test('TEST-11 every entry carries the provenance triplet and the verbatim licence', () => {
  const { methodsDir, staging, manifestPath } = fixtureFull();
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const idx = JSON.parse(fs.readFileSync(path.join(methodsDir, 'index.json'), 'utf8'));
  const indexOf = new Map(idx.methods.map((e) => [e.id, e]));
  assert.equal(m.base_contract, '2.0');
  for (const e of m.envs) {
    // non-empty identity + provenance fields (INV-6: a run and a saved model
    // record these verbatim — method, method version, base digest, env digest).
    for (const f of ['method_id', 'method_version', 'digest', 'base_digest',
                     'oci_ref', 'tag', 'wrapper_code_sha256', 'layer_sha256']) {
      assert.ok(e[f] && String(e[f]).length > 0, `${e.env_id}: ${f} must be non-empty`);
    }
    assert.match(e.digest, /^sha256:[0-9a-f]{64}$/);
    assert.match(e.base_digest, /^sha256:[0-9a-f]{64}$/);
    assert.match(e.layer_sha256, /^[0-9a-f]{64}$/);
    assert.equal(e.oci_ref, `ghcr.io/tinnlab/txr-method-env-layers/${e.env_id}`);
    assert.equal(e.contract, indexOf.get(e.env_id).contract);
    // the licence reproduced VERBATIM from method.json at generation time.
    const mj = JSON.parse(fs.readFileSync(
      path.join(methodsDir, 'methods', e.env_id, 'method.json'), 'utf8'));
    assert.equal(e.licence, mj.licence);
    assert.equal(e.licence, `verbatim-licence-of-${e.env_id}-LLC`);
  }
  // a licence change is a REGENERATION event (run the writer again from the
  // same records), never an edit: the verbatim fact follows method.json.
  const revised = 'verbatim-licence-of-fixture-a-LLC-revised-by-the-facts';
  fs.writeFileSync(path.join(methodsDir, 'methods', 'fixture-a', 'method.json'),
    JSON.stringify({ id: 'fixture-a', licence: revised }));
  const regenerated = path.join(path.dirname(manifestPath), 'manifest-regen.json');
  const r = gen(['--fixture', staging, '--methods-dir', methodsDir, '--manifest', regenerated]);
  assert.equal(r.status, 0, `regeneration refused: ${r.stderr}`);
  const m2 = JSON.parse(fs.readFileSync(regenerated, 'utf8'));
  assert.equal(m2.envs.find((e) => e.env_id === 'fixture-a').licence, revised);
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
  const licence = 'verbatim-licence-of-fixture-v-LLC';
  const d = path.join(methodsDir, 'methods', id);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'method.json'), JSON.stringify({ id, licence, language: 'Python' }));
  fs.writeFileSync(path.join(methodsDir, 'index.json'), JSON.stringify({
    index_version: '2026.10.0',
    contract_versions: ['2.0'],
    methods: [
      { id, version: '1.0.0', language: 'Python', contract: '2.0', runnable: true },
    ],
  }));
  const dir = path.join(staging, 'layers', `${id}-amd64`);
  fs.mkdirSync(dir, { recursive: true });
  const root = path.join(base, `${id}-root`);
  writeLayerRoot(root, { id, licence, run: 'run.py', language: 'Python', withRun });
  stagedLayerRecord(dir, {
    ...RECORD_A,
    env_id: id,
    method_id: id,
    method_version: '1.0.0',
    oci_ref: 'ghcr.io/tinnlab/txr-method-env-layers/fixture-v',
    tag: '1.0.0-amd64',
  }, root, 'run.py', { withRun });
  stageFixtureBase(base, staging, 'base-py', 'amd64');
  const r = gen(['--fixture', staging, '--methods-dir', methodsDir, '--manifest', manifestPath]);
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
    ['schema_version', 'generator_version', 'source_revision', 'base_contract', 'bases', 'envs']);
  assert.deepEqual(m.bases.map((b) => `${b.base_id}-${b.arch}`), ['base-py-amd64', 'base-r-amd64']);
  for (const b of m.bases) {
    assert.deepEqual(Object.keys(b), BASE_FIELDS, 'the schema field order');
    const dir = path.join(staging, 'bases', `${b.base_id}-${b.arch}`);
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'artifact.json'), 'utf8'));
    const bytes = fs.readFileSync(path.join(dir, 'oci-manifest.json'));
    assert.equal(bytes.toString('utf8'), expectedBaseOciBytes(rec), 'the pinned construction');
    assert.equal(b.digest, 'sha256:' + createHash('sha256').update(bytes).digest('hex'));
    assert.equal(b.squashfs_sha256, rec.squashfs_sha256);
    assert.equal(b.tag, `2.0-${b.arch}-${rec.squashfs_sha256.slice(0, 12)}`);
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
  const r = gen(['--fixture', staging, '--methods-dir', methodsDir, '--manifest', path.join(base, 'x.json')]);
  assert.equal(r.status, 1, 'a layer without its base must not be written');
  assert.match(r.stderr, /fixture-b-amd64: no staged base base-r-amd64/);
});

test('TEST-13c the writer refuses a base packed from another image, naming both digests', () => {
  const { staging, methodsDir, base } = fixture();
  const recPath = path.join(staging, 'bases', 'base-py-amd64', 'artifact.json');
  const rec = JSON.parse(fs.readFileSync(recPath, 'utf8'));
  const other = 'sha256:' + 'cd'.repeat(32);
  fs.writeFileSync(recPath, JSON.stringify({ ...rec, source_digest: other }));
  const r = gen(['--fixture', staging, '--methods-dir', methodsDir, '--manifest', path.join(base, 'x.json')]);
  assert.equal(r.status, 1, 'a base from another image must not pair');
  assert.ok(r.stderr.includes(other) && r.stderr.includes(BASE_SOURCE_DIGEST), r.stderr);
  assert.match(r.stderr, /design §7/);
});

test('TEST-13d the writer refuses a stray dir or a dir without a record under bases/', () => {
  const { staging, methodsDir, base } = fixture();
  const stray = path.join(staging, 'bases', 'sha256:abababababab-amd64');
  fs.mkdirSync(stray);
  let r = gen(['--fixture', staging, '--methods-dir', methodsDir, '--manifest', path.join(base, 'x.json')]);
  assert.equal(r.status, 1, 'an old rootfs cache dir under bases/ must be refused');
  assert.match(r.stderr, /base-cache/);
  fs.rmSync(stray, { recursive: true });
  fs.mkdirSync(path.join(staging, 'bases', 'base-py-arm64'));
  r = gen(['--fixture', staging, '--methods-dir', methodsDir, '--manifest', path.join(base, 'x.json')]);
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
    ['a tag with another hash', (m) => { m.bases[0].tag = '2.0-amd64-000000000000'; }, /tag/],
    ['an oci_ref of another base', (m) => { m.bases[0].oci_ref = 'ghcr.io/tinnlab/txresbench-env/base-r'; },
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
  assert.equal(second.record.tag, `2.0-amd64-${second.record.squashfs_sha256.slice(0, 12)}`);
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
    ['base-py', { omit: ['usr/bin/bash'] }, '/bin/bash'],
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
  // An absolute `/bin -> /usr/bin` link resolves inside the base, not the host.
  const root = path.join(dir, 'root-abs');
  writeBaseRoot(root, 'base-r', { binLink: '/usr/bin' });
  const res = pack(root, path.join(dir, 'out-abs'), 'base-r');
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
  const w = gen(['--fixture', staging, '--methods-dir', methodsDir, '--manifest', path.join(base, 'staged.json')]);
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
    `+ oras resolve ${b.oci_ref}:${b.tag}`,
    `+ oras blob push ${b.oci_ref} ${path.join(dir, 'base.squashfs')}`,
    `+ oras blob push ${b.oci_ref} ${path.join(staging, 'publish', 'empty-config.json')}`,
    `+ oras manifest push ${b.oci_ref}:${b.tag} ${path.join(dir, 'oci-manifest.json')}`,
    `+ cosign sign --yes ${b.oci_ref}@${b.digest}`,
  ]) {
    assert.ok(out.includes(line), `missing "${line}" in:\n${out}`);
  }
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
  const flags = ['--manifest', fx.manifestPath, '--staging-dir', fx.staging, '--dry-run'];
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
  const w = gen(['--fixture', fx.staging, '--methods-dir', fx.methodsDir, '--manifest', fx.manifestPath]);
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
  const { dir: stubDir, log, env } = makeStubs(b.digest);
  t.after(() => fs.rmSync(stubDir, { recursive: true, force: true }));
  const r = publisher([
    '--base', 'base-py',
    '--manifest', manifestPath, '--staging-dir', staging, '--methods-dir', methodsDir,
  ], { ...env, ...CREDS });
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
  assert.match(r.stdout, new RegExp(`published : ${b.oci_ref}:${b.tag} @ ${b.digest}`));
  assert.deepEqual(calls(log), [
    'oras login ghcr.io -u stub-user --password-stdin',
    `oras resolve ${b.oci_ref}:${b.tag}`,
    `oras blob push ${b.oci_ref} base.squashfs`,
    `oras blob push ${b.oci_ref} ${path.join(staging, 'publish', 'empty-config.json')}`,
    `oras manifest push ${b.oci_ref}:${b.tag} ${path.join(staging, 'bases', 'base-py-amd64', 'oci-manifest.json')}`,
    `oras resolve ${b.oci_ref}:${b.tag}`,
    `cosign sign --yes ${b.oci_ref}@${b.digest}`,
  ]);
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
  let stub = makeStubs('');
  t.after(() => fs.rmSync(stub.dir, { recursive: true, force: true }));
  let r = publisher(args, { ...stub.env, ...CREDS });
  assert.equal(r.status, 1, `${r.stderr}\n${r.stdout}`);
  assert.match(r.stderr, /publish the base first/);
  assert.match(r.stderr, /--base base-py --arch amd64/);
  assert.ok(!calls(stub.log).some((l) => /oras (blob|manifest) push/.test(l)), 'nothing was pushed');
  // The base tag names other bytes: refused the same way.
  stub = makeStubs('', { [baseRef]: 'sha256:' + '42'.repeat(32) });
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
  assert.ok(calls(stub.log).some((l) => l === `oras manifest push ${layerRef} ${path.join(staging, 'layers', 'fixture-a-amd64', 'oci-manifest.json')}`));
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
    '127.0.0.1:0', '127.0.0.1:70000', '127.0.0.1:5055/x', 'http://127.0.0.1:5055', '[::1]']) {
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
    assert.match(line, /^oras (resolve|blob push|manifest push) --plain-http /, `plain HTTP oras only: ${line}`);
    assert.ok(line.includes(`${reg}/tinnlab/`), `loopback host: ${line}`);
    assert.doesNotMatch(line, /ghcr\.io/, `never ghcr.io: ${line}`);
  }
  assert.ok(c.includes(`oras resolve --plain-http ${local(`${b.oci_ref}:${b.tag}`)}`), 'the base-first check went to the loopback');
  assert.match(r.stdout, /SIGNING SKIPPED: loopback rehearsal/);
});
