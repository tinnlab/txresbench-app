#!/usr/bin/env node
// assemble-method-list.test.mjs — the controls for `scripts/assemble-method-list.py`, the
// writer of the method list. Each test runs the real script as a subprocess over a copy of
// the committed fixture list dir (`scripts/method-list/fixtures/list-dir/`, synthetic
// methods) and reads its exit status and output.
//
//   node --test scripts/assemble-method-list.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'scripts/assemble-method-list.py');
const LIST_DIR = path.join(REPO, 'scripts/method-list/fixtures/list-dir');
const EPOCH = '1767225600';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'assemble-method-list-'));
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, v, indent = 1) => fs.writeFileSync(p, JSON.stringify(v, null, indent) + '\n');

function run(args, env = {}) {
  const r = spawnSync('python3', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', SOURCE_DATE_EPOCH: EPOCH, ...env },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** A copy of the fixture list dir; `previous` is the committed sequence 1 list. */
function listDir() {
  const base = tmp();
  const dir = path.join(base, 'method-list');
  fs.mkdirSync(dir);
  for (const f of ['catalogue.json', 'method-env-images.json']) {
    fs.copyFileSync(path.join(LIST_DIR, f), path.join(dir, f));
  }
  const previous = path.join(base, 'previous.json');
  fs.copyFileSync(path.join(LIST_DIR, 'method-list.json'), previous);
  return { dir, previous, list: path.join(dir, 'method-list.json') };
}

/** Edit a JSON file in Python (`d` is the document): JavaScript cannot write 150.0 or keep 0.0. */
function pyEdit(file, code) {
  const r = spawnSync('python3', ['-c', `import json, sys\np = sys.argv[1]\nd = json.load(open(p))\n${code}\n` +
    "open(p, 'w').write(json.dumps(d, indent=1, sort_keys=True, ensure_ascii=False) + '\\n')", file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

function edit(file, fn, indent = 1) {
  const v = readJson(file);
  fn(v);
  writeJson(file, v, indent);
}

test('writes_previous_plus_one', () => {
  const { dir, previous, list } = listDir();
  const r = run(['--list-dir', dir, '--previous', previous]);
  assert.equal(r.status, 0, r.out);
  const doc = readJson(list);
  assert.equal(doc.sequence, 2);
  assert.equal(doc.format, 'txresbench-method-list');
  assert.equal(doc.format_version, 1);
  assert.equal(doc.assembled_at, '2026-01-01T00:00:00Z');
  assert.deepEqual(doc.catalogue, readJson(path.join(dir, 'catalogue.json')));
  assert.deepEqual(doc.images, readJson(path.join(dir, 'method-env-images.json')));
  // --first gives 1, and with the fixture's epoch it is the committed fixture, byte for byte.
  assert.equal(run(['--list-dir', dir, '--first']).status, 0);
  assert.equal(fs.readFileSync(list, 'utf8'), fs.readFileSync(path.join(LIST_DIR, 'method-list.json'), 'utf8'));
});

test('byte_identical_on_rerun', () => {
  const { dir, previous, list } = listDir();
  assert.equal(run(['--list-dir', dir, '--previous', previous]).status, 0);
  const first = fs.readFileSync(list);
  assert.equal(run(['--list-dir', dir, '--previous', previous]).status, 0);
  assert.ok(first.equals(fs.readFileSync(list)), 'a rerun writes the same bytes');
  const text = first.toString('utf8');
  assert.ok(text.endsWith('}\n'));
  assert.ok(text.startsWith('{\n "assembled_at": '), 'sorted keys, indent 1');
});

test('refuses_without_previous_or_first', () => {
  const { dir, previous, list } = listDir();
  for (const args of [['--list-dir', dir], ['--list-dir', dir, '--first', '--previous', previous]]) {
    const r = run(args);
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /LIST_SEQUENCE/);
  }
  assert.ok(!fs.existsSync(list), 'nothing written');
});

test('refuses_image_entry_without_catalogue_row', () => {
  const { dir, previous, list } = listDir();
  edit(path.join(dir, 'catalogue.json'), (c) => {
    c.methods = c.methods.filter((m) => m.id !== 'fx-baseline-cox');
  });
  const r = run(['--list-dir', dir, '--first']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /LIST_UNKNOWN_METHOD: image entry fx-baseline-cox-amd64/);
  assert.ok(!fs.existsSync(list));
  assert.ok(previous);
});

test('refuses_arch_version_mismatch', () => {
  const { dir } = listDir();
  edit(path.join(dir, 'method-env-images.json'), (img) => {
    const amd = img.envs.find((e) => e.env_id === 'fx-baseline-cox');
    img.envs.push({ ...amd, arch: 'arm64', method_version: '1.1.0' });
  }, 2);
  const r = run(['--list-dir', dir, '--first']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /LIST_VERSION_MISMATCH: image entry fx-baseline-cox-arm64 is version '1\.1\.0'/);
});

test('refuses_removed_row_accepts_retired', () => {
  const { dir, previous, list } = listDir();
  pyEdit(path.join(dir, 'catalogue.json'), "d['methods'] = [m for m in d['methods'] if m['id'] != 'fx-response-signature']");
  const r = run(['--list-dir', dir, '--previous', previous]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /LIST_ROW_REMOVED: method 'fx-response-signature'/);
  assert.ok(!fs.existsSync(list));

  const kept = listDir();
  pyEdit(path.join(kept.dir, 'catalogue.json'), "rows = {m['id']: m for m in d['methods']}\nrows['fx-response-signature']['runnable'] = False");
  const ok = run(['--list-dir', kept.dir, '--previous', kept.previous]);
  assert.equal(ok.status, 0, ok.out);
  assert.equal(readJson(kept.list).catalogue.methods.find((m) => m.id === 'fx-response-signature').runnable, false);
});

test('refuses_fact_change_same_version', () => {
  for (const [field, change] of [
    ['min_draws', "m['min_draws'] += 1"],
    ['params', "m['params']['extra'] = 1"],
    ['tasks', "m['tasks'].append('another')"],
  ]) {
    const { dir, previous } = listDir();
    pyEdit(path.join(dir, 'catalogue.json'), `rows = {m['id']: m for m in d['methods']}\nm = rows['fx-response-signature']\n${change}`);
    const r = run(['--list-dir', dir, '--previous', previous]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, new RegExp(`LIST_FACTS_CHANGED_SAME_VERSION: .*changes ${field}`));
  }
  // A change of type is a change: Python's == takes 0.0 == False and 150 == 150.0.
  for (const [field, code] of [
    ['params', "rows = {m['id']: m for m in d['methods']}\nrows['fx-asm-methylation-panel']['params']['call_cutoff'] = False"],
    ['params', "rows = {m['id']: m for m in d['methods']}\nrows['fx-baseline-cox']['params']['reference_patients'] = 150.0"],
  ]) {
    const { dir, previous } = listDir();
    pyEdit(path.join(dir, 'catalogue.json'), code);
    const r = run(['--list-dir', dir, '--previous', previous]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, new RegExp(`LIST_FACTS_CHANGED_SAME_VERSION: .*changes ${field}`));
  }
  // The same change with a version bump is a new version: accepted. A change outside the
  // run-shaping facts (the description) needs no bump.
  const { dir, previous } = listDir();
  pyEdit(path.join(dir, 'catalogue.json'), "rows = {m['id']: m for m in d['methods']}\nm = rows['fx-response-signature']\nm['min_draws'] += 1\nm['version'] = '0.9.1'\n" +
    "rows['fx-baseline-cox']['description'] = 'Reworded.'");
  const r = run(['--list-dir', dir, '--previous', previous]);
  assert.equal(r.status, 0, r.out);
});

test('check_mode_catches_hand_edit', () => {
  const { dir, previous, list } = listDir();
  assert.equal(run(['--list-dir', dir, '--previous', previous]).status, 0);
  // Later, with another epoch: --check uses the committed header, so it still matches.
  const ok = run(['--list-dir', dir, '--check', '--previous', previous], { SOURCE_DATE_EPOCH: '1800000000' });
  assert.equal(ok.status, 0, ok.out);
  // A hand edit of the list.
  edit(list, (d) => { d.images.envs[0].size_bytes += 1; });
  let r = run(['--list-dir', dir, '--check']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /LIST_STALE: .*first difference at \$\.images\.envs\[0\]\.size_bytes/);
  // A source document changed without a new assembly.
  const again = listDir();
  assert.equal(run(['--list-dir', again.dir, '--previous', again.previous]).status, 0);
  edit(path.join(again.dir, 'catalogue.json'), (c) => { c.methods[0].description = 'Changed.'; });
  r = run(['--list-dir', again.dir, '--check']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /LIST_STALE/);
  // A sequence that is not above the previous one.
  r = run(['--list-dir', LIST_DIR, '--check', '--previous', path.join(LIST_DIR, 'method-list.json')]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /is not above the previous list's 1/);
});

test('refuses_over_size_cap', () => {
  const { dir, list } = listDir();
  edit(path.join(dir, 'catalogue.json'), (c) => {
    c.methods[0].description = 'x'.repeat(16 * 1024 * 1024);
  });
  const r = run(['--list-dir', dir, '--first']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /LIST_TOO_LARGE: the list is \d+ bytes, over the 16777216-byte cap/);
  assert.ok(!fs.existsSync(list));
});

test('extract writes the bytes each generator writes; bootstrap is sequence 0', () => {
  const base = tmp();
  const cat = path.join(base, 'catalogue.json');
  const img = path.join(base, 'images.json');
  const r = run(['--extract', path.join(LIST_DIR, 'method-list.json'), '--catalogue-out', cat, '--images-out', img]);
  assert.equal(r.status, 0, r.out);
  assert.equal(fs.readFileSync(cat, 'utf8'), fs.readFileSync(path.join(LIST_DIR, 'catalogue.json'), 'utf8'));
  assert.equal(fs.readFileSync(img, 'utf8'), fs.readFileSync(path.join(LIST_DIR, 'method-env-images.json'), 'utf8'));
  const boot = path.join(base, 'boot.json');
  const b = run(['--bootstrap', '--catalogue', cat, '--images', img, '--out', boot]);
  assert.equal(b.status, 0, b.out);
  assert.equal(readJson(boot).sequence, 0);
  assert.equal(run(['--sequence-of', boot]).out.trim(), '0');
});

test('diff names added, changed and retired methods and the sequence', () => {
  const { dir, previous, list } = listDir();
  pyEdit(path.join(dir, 'catalogue.json'), "rows = {m['id']: m for m in d['methods']}\nrows['fx-response-signature']['runnable'] = False\n" +
    "rows['fx-baseline-cox']['description'] = 'Reworded.'");
  assert.equal(run(['--list-dir', dir, '--previous', previous]).status, 0);
  const r = run(['--diff', previous, list]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /^sequence: 1 -> 2$/m);
  assert.match(r.out, /^methods changed \(1\): fx-baseline-cox 1\.2\.0 -> 1\.2\.0$/m);
  assert.match(r.out, /^methods retired \(1\): fx-response-signature$/m);
  assert.match(run(['--diff', '-', list]).out, /^methods added \(3\)/m);
  assert.doesNotMatch(r.out, /REMOVED/);
  assert.match(run(['--diff', list, path.join(LIST_DIR, 'method-list.json')]).out, /^sequence: 2 -> 1$/m);
});

test('successor: rules 3 and 5 against an older list', () => {
  const { dir, previous, list } = listDir();
  assert.equal(run(['--list-dir', dir, '--previous', previous]).status, 0);
  assert.equal(run(['--successor', previous, list]).status, 0);
  const dropped = path.join(tmp(), 'dropped.json');
  fs.copyFileSync(list, dropped);
  pyEdit(dropped, "d['catalogue']['methods'] = [m for m in d['catalogue']['methods'] if m['id'] != 'fx-response-signature']");
  const r = run(['--successor', previous, dropped]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /LIST_ROW_REMOVED/);
  assert.match(run(['--diff', previous, dropped]).out, /^methods REMOVED \(1\): fx-response-signature$/m);
  // A fact whose type changed at the same version (150 -> 150.0) is refused too.
  const retyped = path.join(tmp(), 'retyped.json');
  fs.copyFileSync(list, retyped);
  pyEdit(retyped, "rows = {m['id']: m for m in d['catalogue']['methods']}\nrows['fx-baseline-cox']['params']['reference_patients'] = 150.0");
  const t = run(['--successor', previous, retyped]);
  assert.equal(t.status, 1, t.out);
  assert.match(t.out, /LIST_FACTS_CHANGED_SAME_VERSION: method 'fx-baseline-cox'/);
});
