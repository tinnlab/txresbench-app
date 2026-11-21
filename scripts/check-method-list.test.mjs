#!/usr/bin/env node
// check-method-list.test.mjs — the controls for `scripts/check-method-list.sh`.
//
// Every assertion drives the REAL guard as a subprocess over a copy of the committed
// fixture list (`scripts/method-list/fixtures/list-dir/`, synthetic methods) or over a
// small app tree built here, and reads the child's own exit status. Each refusal is shown
// red on exactly the shape it names; the valid shapes are shown green, so a guard that
// refused everything would fail here too.
//
//   node --test scripts/check-method-list.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = path.join(REPO, 'scripts/check-method-list.sh');
const FIXTURES = path.join(REPO, 'scripts/method-list/fixtures');
const LIST_DIR = path.join(FIXTURES, 'list-dir');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'check-method-list-'));
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, v, indent = 1) => fs.writeFileSync(p, JSON.stringify(v, null, indent) + '\n');

function guard(...args) {
  const r = spawnSync('bash', [GUARD, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** A copy of the fixture list dir (catalogue.json, method-env-images.json, method-list.json). */
function listDir() {
  const dir = path.join(tmp(), 'method-list');
  fs.mkdirSync(dir);
  for (const f of ['catalogue.json', 'method-env-images.json', 'method-list.json']) {
    fs.copyFileSync(path.join(LIST_DIR, f), path.join(dir, f));
  }
  return dir;
}

/** An app tree: trusted keys (none), the fixture public key, and optionally an imported list. */
function appTree({ sequence = null, signature = null, keys = [] } = {}) {
  const dir = tmp();
  for (const d of ['data/method-list', 'data/method-catalogue', 'src-app/server/data', 'scripts/method-list/fixtures']) {
    fs.mkdirSync(path.join(dir, d), { recursive: true });
  }
  fs.copyFileSync(path.join(FIXTURES, 'test-key.pub'), path.join(dir, 'scripts/method-list/fixtures/test-key.pub'));
  writeJson(path.join(dir, 'data/method-list/trusted-keys.json'), {
    format: 'txresbench-method-list-keys',
    format_version: 1,
    keys,
  });
  if (sequence !== null) {
    // A text edit: a JSON round trip here would print 0.0 as 0 (another value to the guard).
    const text = fs.readFileSync(path.join(LIST_DIR, 'method-list.json'), 'utf8');
    assert.match(text, /^ "sequence": 1$/m);
    fs.writeFileSync(path.join(dir, 'data/method-list/method-list.json'),
      text.replace(/^ "sequence": 1$/m, ` "sequence": ${sequence}`));
    fs.copyFileSync(path.join(LIST_DIR, 'catalogue.json'), path.join(dir, 'data/method-catalogue/catalogue.json'));
    fs.copyFileSync(path.join(LIST_DIR, 'method-env-images.json'), path.join(dir, 'src-app/server/data/method-env-images.json'));
  }
  if (signature) {
    fs.copyFileSync(signature, path.join(dir, 'data/method-list/method-list.json.minisig'));
  }
  return dir;
}

const fixtureKey = () => readJson(path.join(FIXTURES, 'fixture-keys.json')).keys[0];

// ── methods mode ────────────────────────────────────────────────────────────────

test('methods mode: the fixture list passes (header, nested documents, rules, parity)', () => {
  const r = guard('--list-dir', listDir());
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /check-method-list: OK/);
  assert.match(r.out, /matches its assembly/);
});

test('methods mode: a nested document that is not its source file fails', () => {
  const dir = listDir();
  const cat = readJson(path.join(dir, 'catalogue.json'));
  cat.methods[0].title = 'Another title';
  writeJson(path.join(dir, 'catalogue.json'), cat);
  const r = guard('--list-dir', dir);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /the nested catalogue is not/);
});

test('methods mode: an unknown header field fails', () => {
  const dir = listDir();
  const list = readJson(path.join(dir, 'method-list.json'));
  list.note = 'hand-added';
  writeJson(path.join(dir, 'method-list.json'), list);
  const r = guard('--list-dir', dir);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /unknown header field\(s\) note/);
});

test('methods mode: a wrong format or format_version fails', () => {
  for (const [field, value] of [['format', 'another-list'], ['format_version', 3]]) {
    const dir = listDir();
    const list = readJson(path.join(dir, 'method-list.json'));
    list[field] = value;
    writeJson(path.join(dir, 'method-list.json'), list);
    const r = guard('--list-dir', dir);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, new RegExp(`${field} is .*must be`));
  }
});

test('methods mode: sequence 0 (the bootstrap copy) is refused in the methods repository', () => {
  const dir = listDir();
  const list = readJson(path.join(dir, 'method-list.json'));
  list.sequence = 0;
  writeJson(path.join(dir, 'method-list.json'), list);
  const r = guard('--list-dir', dir);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /sequence 0 is below 1/);
});

test('methods mode: an oversize list fails before it is parsed', () => {
  const dir = listDir();
  fs.writeFileSync(path.join(dir, 'method-list.json'), `{"pad": "${'x'.repeat(16 * 1024 * 1024)}"}`);
  const r = guard('--list-dir', dir);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /LIST_TOO_LARGE/);
});

test('methods mode: a hand-edited layout fails parity (the content still matches)', () => {
  const dir = listDir();
  const relayout = spawnSync('python3', ['-c',
    'import json,sys; p=sys.argv[1]; d=json.load(open(p)); open(p,"w").write(json.dumps(d, indent=2, sort_keys=True) + "\\n")',
    path.join(dir, 'method-list.json')]);
  assert.equal(relayout.status, 0, String(relayout.stderr));
  const r = guard('--list-dir', dir);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /LIST_STALE/);
  assert.match(r.out, /parity/);
});

test('methods mode: an image entry without its row, or at another version, fails', () => {
  const cases = [
    [(cat) => { cat.methods = cat.methods.filter((m) => m.id !== 'fx-baseline-cox'); }, /LIST_UNKNOWN_METHOD/],
    [(cat) => { cat.methods.find((m) => m.id === 'fx-baseline-cox').version = '1.3.0'; }, /LIST_VERSION_MISMATCH/],
  ];
  for (const [edit, want] of cases) {
    const dir = listDir();
    const list = readJson(path.join(dir, 'method-list.json'));
    edit(list.catalogue);
    writeJson(path.join(dir, 'method-list.json'), list);
    writeJson(path.join(dir, 'catalogue.json'), list.catalogue);
    const r = guard('--list-dir', dir);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, want);
  }
});

test('methods mode with --previous: a removed row or a fact changed at the same version fails', () => {
  const prevDir = tmp();
  const previous = readJson(path.join(LIST_DIR, 'method-list.json'));
  const cases = [
    [(cat) => { cat.methods = cat.methods.filter((m) => m.id !== 'fx-response-signature'); }, /LIST_ROW_REMOVED/],
    [(cat) => { cat.methods.find((m) => m.id === 'fx-response-signature').min_draws += 1; }, /LIST_FACTS_CHANGED_SAME_VERSION.*min_draws/],
  ];
  for (const [edit, want] of cases) {
    const dir = listDir();
    const list = readJson(path.join(dir, 'method-list.json'));
    list.sequence = 2;
    edit(list.catalogue);
    writeJson(path.join(dir, 'method-list.json'), list);
    writeJson(path.join(dir, 'catalogue.json'), list.catalogue);
    writeJson(path.join(prevDir, 'previous.json'), previous);
    const r = guard('--list-dir', dir, '--previous', path.join(prevDir, 'previous.json'));
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, want);
  }
  // A fact whose type changed at the same version (0.0 -> false, 150 -> 150.0): Python's ==
  // takes both as equal. The list is written in the assembler's layout, so parity holds.
  for (const code of [
    "rows['fx-asm-methylation-panel']['params']['call_cutoff'] = False",
    "rows['fx-baseline-cox']['params']['reference_patients'] = 150.0",
  ]) {
    const dir = listDir();
    const py = spawnSync('python3', ['-c', `import json, sys
p = sys.argv[1]
d = json.load(open(p + '/method-list.json'))
d['sequence'] = 2
rows = {m['id']: m for m in d['catalogue']['methods']}
${code}
open(p + '/method-list.json', 'w').write(json.dumps(d, indent=1, sort_keys=True, ensure_ascii=False) + '\\n')
open(p + '/catalogue.json', 'w').write(json.dumps(d['catalogue'], indent=1, sort_keys=True, ensure_ascii=False) + '\\n')`, dir], { encoding: 'utf8' });
    assert.equal(py.status, 0, py.stderr);
    const r = guard('--list-dir', dir, '--previous', path.join(LIST_DIR, 'method-list.json'));
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /LIST_FACTS_CHANGED_SAME_VERSION: .*changes params/);
  }
  // The same sequence as the previous list fails.
  const same = guard('--list-dir', listDir(), '--previous', path.join(LIST_DIR, 'method-list.json'));
  assert.equal(same.status, 1, same.out);
  assert.match(same.out, /not above the previous list's 1/);
  // A retired row (runnable: false) is a kept row: the writer's next list passes.
  const dir = listDir();
  const py = spawnSync('python3', ['-c', `import json, sys
p = sys.argv[1] + '/catalogue.json'
d = json.load(open(p))
next(m for m in d['methods'] if m['id'] == 'fx-response-signature')['runnable'] = False
open(p, 'w').write(json.dumps(d, indent=1, sort_keys=True, ensure_ascii=False) + '\\n')`, dir], { encoding: 'utf8' });
  assert.equal(py.status, 0, py.stderr);
  const w = spawnSync('python3', [path.join(REPO, 'scripts/assemble-method-list.py'), '--list-dir', dir,
    '--previous', path.join(LIST_DIR, 'method-list.json')], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(w.status, 0, w.stderr);
  const r = guard('--list-dir', dir, '--previous', path.join(LIST_DIR, 'method-list.json'));
  assert.equal(r.status, 0, r.out);
});

// ── app mode ────────────────────────────────────────────────────────────────────

test('app mode: this tree passes', () => {
  const r = guard();
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /the fixture key is not one/);
});

test('app mode: sequence 0 without a signature passes; with one it fails', () => {
  assert.equal(guard('--app-dir', appTree({ sequence: 0 })).status, 0);
  const r = guard('--app-dir', appTree({ sequence: 0, signature: path.join(LIST_DIR, 'method-list.json.minisig') }));
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /sequence 0 is the unsigned bootstrap copy/);
});

test('app mode: sequence 1 without its signature fails', () => {
  const r = guard('--app-dir', appTree({ sequence: 1 }));
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /has no method-list\.json\.minisig/);
});

test('app mode: a signature by a key the app does not trust fails', () => {
  const r = guard('--app-dir', appTree({ sequence: 1, signature: path.join(LIST_DIR, 'method-list.json.minisig') }));
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /signed by key 73D9638AD48C0903, which is not in/);
});

test('app mode: an extracted copy that differs from the nested document fails', () => {
  const dir = appTree({ sequence: 0 });
  const p = path.join(dir, 'src-app/server/data/method-env-images.json');
  const images = readJson(p);
  images.envs[0].size_bytes += 1;
  writeJson(p, images, 2);
  const r = guard('--app-dir', dir);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /src-app\/server\/data\/method-env-images\.json is not the images/);
});

test('app mode: an extracted copy that differs only in a value\'s type (1 vs true) fails', () => {
  const dir = appTree({ sequence: 0 });
  const p = path.join(dir, 'src-app/server/data/method-env-images.json');
  const images = readJson(p);
  images.envs[0].layer_schema = true; // equal to 1 under Python's ==
  writeJson(p, images, 2);
  const r = guard('--app-dir', dir);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /is not the images/);
});

test('app mode: the fixture key in the trusted set fails', () => {
  const r = guard('--app-dir', appTree({ keys: [fixtureKey()] }));
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /trusts the FIXTURE key 73D9638AD48C0903/);
  // Under another label, or with the id spelled from the key, it is still the fixture key.
  const renamed = { ...fixtureKey(), label: 'maintainer' };
  assert.equal(guard('--app-dir', appTree({ keys: [renamed] })).status, 1);
});

test('app mode: a key whose key_id is not its own fails', () => {
  const other = {
    label: 'other',
    key_id: '0000000000000000',
    public_key: 'RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3',
  };
  const r = guard('--app-dir', appTree({ keys: [other] }));
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /is not the key's own id E7620F1842B4E81F/);
  assert.equal(guard('--app-dir', appTree({ keys: [{ ...other, key_id: 'E7620F1842B4E81F' }] })).status, 0);
});

test('app mode: a missing fixture public key fails (it is what proves the key is not trusted)', () => {
  const dir = appTree();
  fs.rmSync(path.join(dir, 'scripts/method-list/fixtures/test-key.pub'));
  const r = guard('--app-dir', dir);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /needed to prove it is not trusted/);
});

test('the guard and these controls are pinned in guard-hashes.txt', () => {
  const pins = fs.readFileSync(path.join(REPO, 'scripts/guard-hashes.txt'), 'utf8');
  assert.match(pins, / scripts\/check-method-list\.sh$/m);
  assert.match(pins, / scripts\/check-method-list\.test\.mjs$/m);
});
