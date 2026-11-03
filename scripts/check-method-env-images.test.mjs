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
//            guard is unaffected (no allowlist edit; DEC-17)
//   TEST-6   both files pinned in scripts/guard-hashes.txt; an unpinned
//            guard-shaped file fails check 2 of check-guard-integrity.sh
//
//   node --test scripts/check-method-env-images.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SCRIPTS_DIR, '..');
const GUARD = path.join(SCRIPTS_DIR, 'check-method-env-images.sh');
const GENERATOR = path.join(SCRIPTS_DIR, 'generate-method-env-images.py');
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
 *  the real generator's --fixture mode and returned as its path. */
function fixture() {
  const base = mkdtemp('mei-fixture-');
  const methodsDir = path.join(base, 'methods');
  const staging = path.join(base, 'staged');
  const manifestPath = path.join(base, 'manifest.json');
  for (const id of ['fixture-a', 'fixture-b']) {
    fs.mkdirSync(path.join(methodsDir, 'methods', id), { recursive: true });
    fs.writeFileSync(
      path.join(methodsDir, 'methods', id, 'method.json'),
      JSON.stringify({ id, licence: `verbatim-licence-of-${id}-LLC` }),
    );
  }
  fs.writeFileSync(path.join(methodsDir, 'index.json'), JSON.stringify(INDEX));
  for (const [id, rec] of [['fixture-a', RECORD_A], ['fixture-b', RECORD_B]]) {
    const dir = path.join(staging, 'layers', `${id}-amd64`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'artifact.json'), JSON.stringify(rec, null, 2));
    fs.writeFileSync(path.join(dir, 'layer.squashfs'), Buffer.alloc(4096, 1));
  }
  const r = gen(['--fixture', staging, '--methods-dir', methodsDir, '--manifest', manifestPath]);
  assert.equal(r.status, 0, `fixture manifest did not assemble: ${r.stderr}`);
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
