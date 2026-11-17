#!/usr/bin/env node
// import-method-list.test.mjs — the controls for `scripts/import-method-list.sh`.
//
// The registry is the stub `oras` (scripts/method-list/stubs.mjs); the list is the fixture
// signed with the REAL minisign by the test key (scripts/method-list/fixtures/), checked
// with the test key through `--keys` by a verifier that does the real minisign check with
// node:crypto — or by the real binary when TXR_CLI names one. The import writes into a
// throwaway app tree (`--app-dir`); this checkout is never touched.
//
//   node --test scripts/import-method-list.test.mjs
//   TXR_CLI=<target>/debug/txresbench node --test scripts/import-method-list.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readLog, seedArtifact, writeCargoStub, writeStubs, writeVerifyingCli } from './method-list/stubs.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'scripts/import-method-list.sh');
const FIXTURES = path.join(REPO, 'scripts/method-list/fixtures');
const LIST_DIR = path.join(FIXTURES, 'list-dir');
const KEYS = path.join(FIXTURES, 'fixture-keys.json');
const PACKAGE = 'ghcr.io/tinnlab/txresbench-method-list';
const LIST = fs.readFileSync(path.join(LIST_DIR, 'method-list.json'));
const SIG = fs.readFileSync(path.join(LIST_DIR, 'method-list.json.minisig'));

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'import-method-list-'));
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

/** A registry holding `files` at :v1 (and at :v1-seq-<n>), and an app tree: its current two
 * documents (`current`: the fixture's, or with one extra row, or not documents at all) and
 * optionally a built-in list at sequence `builtin`. */
function world({ files = { 'method-list.json': LIST, 'method-list.json.minisig': SIG }, builtin = null,
  current = 'fixture' } = {}) {
  const base = tmp();
  const bin = path.join(base, 'bin');
  writeStubs(bin);
  const cli = process.env.TXR_CLI || writeVerifyingCli(bin);
  seedArtifact(bin, PACKAGE, 'v1', files, `sha256:${'b'.repeat(64)}`);
  seedArtifact(bin, PACKAGE, 'v1-seq-000001', files, `sha256:${'b'.repeat(64)}`);
  const app = path.join(base, 'app');
  for (const d of ['data/method-list', 'data/method-catalogue', 'src-app/server/data', 'scripts/method-list/fixtures']) {
    fs.mkdirSync(path.join(app, d), { recursive: true });
  }
  // The app's current copies.
  const cat = path.join(app, 'data/method-catalogue/catalogue.json');
  if (current === 'invalid') {
    fs.writeFileSync(cat, '{"old": true}\n');
  } else {
    fs.copyFileSync(path.join(LIST_DIR, 'catalogue.json'), cat);
  }
  if (current === 'extra-row') {
    const py = spawnSync('python3', ['-c', `import copy, json, sys
p = sys.argv[1]
d = json.load(open(p))
row = copy.deepcopy(d['methods'][0])
row['id'] = 'fx-only-in-the-app'
d['methods'].append(row)
open(p, 'w').write(json.dumps(d, indent=1, sort_keys=True, ensure_ascii=False) + '\\n')`, cat], { encoding: 'utf8' });
    assert.equal(py.status, 0, py.stderr);
  }
  fs.copyFileSync(path.join(LIST_DIR, 'method-env-images.json'), path.join(app, 'src-app/server/data/method-env-images.json'));
  fs.copyFileSync(path.join(REPO, 'data/method-list/trusted-keys.json'), path.join(app, 'data/method-list/trusted-keys.json'));
  fs.copyFileSync(path.join(FIXTURES, 'test-key.pub'), path.join(app, 'scripts/method-list/fixtures/test-key.pub'));
  if (builtin !== null) {
    // A text edit: a JSON round trip in JavaScript would print 0.0 as 0 (another value).
    fs.writeFileSync(path.join(app, 'data/method-list/method-list.json'),
      LIST.toString('utf8').replace(/^ "sequence": 1$/m, ` "sequence": ${builtin}`));
  }
  return { base, bin, cli, app };
}

function run(w, extra = []) {
  const r = spawnSync('bash', [SCRIPT, '--app-dir', w.app, '--keys', KEYS, '--cli', w.cli, ...extra], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${w.bin}:${process.env.PATH}`, TMPDIR: w.base, PYTHONDONTWRITEBYTECODE: '1' },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
const appFile = (w, rel) => path.join(w.app, rel);

test('refuses_bad_signature', () => {
  const flipped = Buffer.from(LIST);
  flipped[Math.floor(flipped.length / 2)] ^= 1;
  const w = world({ files: { 'method-list.json': flipped, 'method-list.json.minisig': SIG } });
  const r = run(w);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /METHOD_LIST_BAD_SIGNATURE/);
  assert.match(r.out, /does not verify with the app's trusted keys: not imported/);
  assert.ok(!fs.existsSync(appFile(w, 'data/method-list/method-list.json')));
  assert.equal(fs.readFileSync(appFile(w, 'data/method-catalogue/catalogue.json'), 'utf8'),
    fs.readFileSync(path.join(LIST_DIR, 'catalogue.json'), 'utf8'));
});

test('without a built-in list, refuses a list that drops a row of the app\'s current documents', () => {
  const w = world({ current: 'extra-row' });
  const before = fs.readFileSync(appFile(w, 'data/method-catalogue/catalogue.json'));
  const r = run(w);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /LIST_ROW_REMOVED: method 'fx-only-in-the-app'/);
  assert.match(r.out, /does not keep the rows and facts of the app's current documents/);
  assert.ok(before.equals(fs.readFileSync(appFile(w, 'data/method-catalogue/catalogue.json'))));
  assert.ok(!fs.existsSync(appFile(w, 'data/method-list/method-list.json')));
  // Current documents that are not a list's documents are not silently replaced either.
  const bad = run(world({ current: 'invalid' }));
  assert.equal(bad.status, 1, bad.out);
  assert.match(bad.out, /the app's current documents are not a method list's/);
});

test('a TXR_CLI left in the environment is refused; --cli names the verifier', () => {
  const w = world();
  const r = spawnSync('bash', [SCRIPT, '--app-dir', w.app, '--keys', KEYS], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${w.bin}:${process.env.PATH}`, TMPDIR: w.base, TXR_CLI: w.cli },
  });
  assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /TXR_CLI is set .* pass --cli/);
  assert.ok(!fs.existsSync(appFile(w, 'data/method-list/method-list.json')));
});

test('the default verifier is cargo run from this checkout, wherever the import is started', () => {
  const w = world();
  writeCargoStub(w.bin, w.cli);
  const env = { ...process.env, PATH: `${w.bin}:${process.env.PATH}`, TMPDIR: w.base, PYTHONDONTWRITEBYTECODE: '1' };
  delete env.TXR_CLI;
  const r = spawnSync('bash', [SCRIPT, '--app-dir', w.app, '--keys', KEYS], { encoding: 'utf8', env, cwd: w.base });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const calls = readLog(w.bin, 'cargo');
  assert.ok(calls.length >= 1);
  for (const c of calls) {
    assert.equal(fs.realpathSync(c.cwd), fs.realpathSync(REPO), 'cargo runs in the app checkout (its .cargo/config.toml)');
    assert.deepEqual(c.argv.slice(0, 6), ['run', '--quiet', '--manifest-path', path.join(REPO, 'src-app/server/Cargo.toml'), '--bin', 'txresbench']);
  }
});

test('refuses_lower_sequence', () => {
  const w = world({ builtin: 2 });
  const before = fs.readFileSync(appFile(w, 'data/method-list/method-list.json'));
  const r = run(w);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /is sequence 1, below the built-in #2/);
  assert.ok(before.equals(fs.readFileSync(appFile(w, 'data/method-list/method-list.json'))));
  // The same sequence with other bytes is refused too; with the same bytes it is a no-op.
  const other = world({ builtin: 1 });
  const builtin = appFile(other, 'data/method-list/method-list.json');
  fs.writeFileSync(builtin, fs.readFileSync(builtin, 'utf8').replace('"assembled_at": "2026-01-01T00:00:00Z"',
    '"assembled_at": "2026-01-01T00:00:01Z"'));
  assert.match(run(other).out, /the built-in #1 holds OTHER bytes/);
  const same = world();
  fs.writeFileSync(appFile(same, 'data/method-list/method-list.json'), LIST);
  const r2 = run(same);
  assert.equal(r2.status, 0, r2.out);
  assert.match(r2.out, /already #1/);
});

test('refuses a list that drops a row of the built-in one', () => {
  const w = world();
  const builtin = appFile(w, 'data/method-list/method-list.json');
  fs.writeFileSync(builtin, LIST);
  const py = spawnSync('python3', ['-c', `import copy, json, sys
p = sys.argv[1]
d = json.load(open(p))
d['sequence'] = 0
row = copy.deepcopy(d['catalogue']['methods'][0])
row['id'] = 'fx-only-in-the-built-in'
d['catalogue']['methods'].append(row)
open(p, 'w').write(json.dumps(d, indent=1, sort_keys=True, ensure_ascii=False) + '\\n')`, builtin], { encoding: 'utf8' });
  assert.equal(py.status, 0, py.stderr);
  const r = run(w);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /LIST_ROW_REMOVED: method 'fx-only-in-the-built-in'/);
  assert.match(r.out, /does not keep the rows and facts of the built-in #0/);
  assert.ok(!fs.existsSync(appFile(w, 'data/method-list/method-list.json.minisig')));
});

test('writes_list_sig_and_both_extracted_docs', () => {
  const w = world({ builtin: 0 });
  const r = run(w);
  assert.equal(r.status, 0, r.out);
  assert.ok(fs.readFileSync(appFile(w, 'data/method-list/method-list.json')).equals(LIST));
  assert.ok(fs.readFileSync(appFile(w, 'data/method-list/method-list.json.minisig')).equals(SIG));
  // Each document in its own generator's layout: the fixture source files, byte for byte.
  assert.equal(fs.readFileSync(appFile(w, 'data/method-catalogue/catalogue.json'), 'utf8'),
    fs.readFileSync(path.join(LIST_DIR, 'catalogue.json'), 'utf8'));
  assert.equal(fs.readFileSync(appFile(w, 'src-app/server/data/method-env-images.json'), 'utf8'),
    fs.readFileSync(path.join(LIST_DIR, 'method-env-images.json'), 'utf8'));
  assert.match(r.out, /^sequence: 0 -> 1$/m);
  assert.match(r.out, /update the app tests that pin counts/);
  assert.deepEqual(fs.readdirSync(w.base).filter((f) => f.startsWith('import-method-list.')), [], 'work dir removed');
});

test('extracted_docs_equal_nested_docs', () => {
  const w = world();
  assert.equal(run(w).status, 0);
  const list = readJson(appFile(w, 'data/method-list/method-list.json'));
  assert.deepEqual(readJson(appFile(w, 'data/method-catalogue/catalogue.json')), list.catalogue);
  assert.deepEqual(readJson(appFile(w, 'src-app/server/data/method-env-images.json')), list.images);
  // The list guard's app-mode copy check agrees (its signature key check is its own: the
  // fixture key is, rightly, not trusted).
  const g = spawnSync('bash', [path.join(REPO, 'scripts/check-method-list.sh'), '--app-dir', w.app], { encoding: 'utf8' });
  assert.equal(g.status, 1);
  assert.match(g.stderr, /signed by key 73D9638AD48C0903, which is not in/);
});

test('bootstrap_writes_sequence_0_without_signature', () => {
  const w = world();
  fs.copyFileSync(path.join(LIST_DIR, 'catalogue.json'), appFile(w, 'data/method-catalogue/catalogue.json'));
  fs.copyFileSync(path.join(LIST_DIR, 'method-env-images.json'), appFile(w, 'src-app/server/data/method-env-images.json'));
  const r = spawnSync('bash', [SCRIPT, '--app-dir', w.app, '--cli', w.cli, '--bootstrap'], {
    encoding: 'utf8', env: { ...process.env, TMPDIR: w.base, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const list = readJson(appFile(w, 'data/method-list/method-list.json'));
  assert.equal(list.sequence, 0);
  assert.ok(!fs.existsSync(appFile(w, 'data/method-list/method-list.json.minisig')));
  assert.deepEqual(list.catalogue, readJson(path.join(LIST_DIR, 'catalogue.json')));
  // The two files are unchanged, and the guard accepts the tree.
  assert.equal(fs.readFileSync(appFile(w, 'data/method-catalogue/catalogue.json'), 'utf8'),
    fs.readFileSync(path.join(LIST_DIR, 'catalogue.json'), 'utf8'));
  const g = spawnSync('bash', [path.join(REPO, 'scripts/check-method-list.sh'), '--app-dir', w.app], { encoding: 'utf8' });
  assert.equal(g.status, 0, `${g.stdout}${g.stderr}`);
  // After a published import, --bootstrap is refused.
  const w2 = world();
  assert.equal(run(w2).status, 0);
  const r2 = spawnSync('bash', [SCRIPT, '--app-dir', w2.app, '--cli', w2.cli, '--bootstrap'], { encoding: 'utf8' });
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /carries published list #1: --bootstrap is for before the first publish only/);
});

test('pulls_with_empty_registry_config', () => {
  const w = world();
  assert.equal(run(w).status, 0);
  let calls = readLog(w.bin, 'oras');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sub, 'pull');
  assert.equal(calls[0].configText, '{}');
  assert.ok(!calls[0].plain);
  assert.ok(calls[0].argv.includes(`${PACKAGE}:v1`));
  const w2 = world();
  assert.equal(run(w2, ['--sequence', '1']).status, 0);
  calls = readLog(w2.bin, 'oras');
  assert.ok(calls[0].argv.includes(`${PACKAGE}:v1-seq-000001`));
});

test('refuses an artifact with other files, and --keys into this checkout', () => {
  const w = world({ files: { 'method-list.json': LIST, 'method-list.json.minisig': SIG, 'extra.txt': Buffer.from('x') } });
  const r = run(w);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /is not exactly method-list\.json \+ method-list\.json\.minisig/);
  const env = { ...process.env };
  delete env.TXR_CLI; // this case is about --keys (the suite may run with TXR_CLI set)
  const here = spawnSync('bash', [SCRIPT, '--keys', KEYS], { encoding: 'utf8', env });
  assert.equal(here.status, 2);
  assert.match(here.stderr, /never writes into this checkout/);
});
