#!/usr/bin/env node
// publish-method-list.test.mjs — the controls for `scripts/publish-method-list.sh`.
//
// Each test builds two throwaway git checkouts with bare origins (an app checkout holding
// copies of the publisher, the assembler, the list guard and its schema; a methods checkout
// holding method-list/ assembled from the fixture documents), a stub registry, and stub
// `oras`, `minisign` and `txresbench` (scripts/method-list/stubs.mjs). The REAL publisher,
// assembler and list guard run; the images guard is a stub that logs its arguments (its
// own controls are scripts/check-method-env-images.test.mjs). No network, no real key.
//
//   node --test scripts/publish-method-list.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STUB_KEY, readLog, seedArtifact, stubSignature, writeStubs } from './method-list/stubs.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIST_DIR = path.join(REPO, 'scripts/method-list/fixtures/list-dir');
const PACKAGE = 'ghcr.io/tinnlab/txresbench-method-list';
const TOKEN = 'ghp_stubtoken0123456789';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'publish-method-list-'));
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, v, indent = 2) => fs.writeFileSync(p, JSON.stringify(v, null, indent) + '\n');

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stdout}${r.stderr}`);
  return r.stdout.trim();
}
const git = (dir, ...args) =>
  sh('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args]);

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  sh('git', ['init', '-q', '-b', 'main', dir]);
  const origin = `${dir}-origin.git`;
  sh('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  git(dir, 'remote', 'add', 'origin', origin);
  return origin;
}
function commitAll(dir, msg, push = true) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
  if (push) git(dir, 'push', '-q', 'origin', 'main');
  return git(dir, 'rev-parse', 'HEAD');
}
function assemble(listDir, args) {
  sh('python3', [path.join(REPO, 'scripts/assemble-method-list.py'), '--list-dir', listDir, ...args], {
    env: { ...process.env, SOURCE_DATE_EPOCH: '1767225600', PYTHONDONTWRITEBYTECODE: '1' },
  });
}

/**
 * The world of one test. Defaults: the published :v1 holds sequence 1, the methods main
 * holds sequence 2, every pin resolves.
 */
function world({ publishedSeq = 1, noBases = false, sideRevision = false, unpinned = null } = {}) {
  const base = tmp();
  const bin = path.join(base, 'bin');
  const stubs = writeStubs(bin);

  // The app checkout: the tools under test + the trusted keys holding the stub key.
  const app = path.join(base, 'app');
  initRepo(app);
  for (const rel of ['scripts/publish-method-list.sh', 'scripts/assemble-method-list.py', 'scripts/check-method-list.sh',
    'data/method-list/method-list.schema.json']) {
    fs.mkdirSync(path.dirname(path.join(app, rel)), { recursive: true });
    fs.copyFileSync(path.join(REPO, rel), path.join(app, rel));
  }
  writeJson(path.join(app, 'data/method-list/trusted-keys.json'),
    { format: 'txresbench-method-list-keys', format_version: 1, keys: [STUB_KEY] }, 1);
  fs.writeFileSync(path.join(app, 'scripts/check-method-env-images.sh'),
    `#!/usr/bin/env bash\necho "$*" >> "${path.join(bin, 'images-guard.log')}"\n`);
  fs.chmodSync(path.join(app, 'scripts/check-method-env-images.sh'), 0o755);
  commitAll(app, 'tools');

  // The methods checkout: a code commit, then method-list/ built at it.
  const methods = path.join(base, 'methods');
  initRepo(methods);
  fs.mkdirSync(path.join(methods, 'methods/fx'), { recursive: true });
  fs.writeFileSync(path.join(methods, 'methods/fx/run.py'), 'print(1)\n');
  let rev = commitAll(methods, 'method code');
  if (sideRevision) {
    git(methods, 'checkout', '-q', '-b', 'side');
    fs.writeFileSync(path.join(methods, 'methods/fx/run.py'), 'print(2)\n');
    rev = commitAll(methods, 'side code', false);
    git(methods, 'checkout', '-q', 'main');
  }
  const listDir = path.join(methods, 'method-list');
  fs.mkdirSync(listDir);
  fs.copyFileSync(path.join(LIST_DIR, 'catalogue.json'), path.join(listDir, 'catalogue.json'));
  const images = readJson(path.join(LIST_DIR, 'method-env-images.json'));
  for (const e of images.envs) e.source_revision = rev.slice(0, 12);
  if (noBases) delete images.bases;
  writeJson(path.join(listDir, 'method-env-images.json'), images);
  assemble(listDir, ['--first']);
  const seq1 = fs.readFileSync(path.join(listDir, 'method-list.json'));
  const prev = path.join(base, 'seq1.json');
  fs.writeFileSync(prev, seq1);
  assemble(listDir, ['--previous', prev]);
  const methodsCommit = commitAll(methods, 'list 2');

  // The registry: every pin, and the published list.
  for (const e of [...(images.bases || []), ...images.envs]) {
    if (unpinned && e.tag === unpinned) continue;
    seedArtifact(bin, e.oci_ref, e.tag, { 'layer.squashfs': Buffer.from(e.tag) }, e.digest);
  }
  let published = null;
  if (publishedSeq !== null) {
    const doc = JSON.parse(seq1);
    doc.sequence = publishedSeq;
    published = Buffer.from(JSON.stringify(doc, null, 1) + '\n');
    seedArtifact(bin, PACKAGE, 'v1', {
      'method-list.json': published,
      'method-list.json.minisig': stubSignature(published, `txresbench-method-list format=1 sequence=${publishedSeq}`),
    }, `sha256:${'a'.repeat(64)}`);
  }
  const key = path.join(base, 'secret.key');
  fs.writeFileSync(key, 'stub secret key\n', { mode: 0o600 });
  return { base, bin, stubs, app, methods, listDir, key, methodsCommit, published };
}

function publish(w, extra = [], env = {}) {
  const r = spawnSync('bash', [path.join(w.app, 'scripts/publish-method-list.sh'), '--methods-dir', w.methods,
    '--key', w.key, '--cli', w.stubs.txresbench, ...extra], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${w.bin}:${process.env.PATH}`, GHCR_USER: 'maintainer', GHCR_TOKEN: TOKEN,
      TMPDIR: w.base, PYTHONDONTWRITEBYTECODE: '1', ...env },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
const pushes = (w) => readLog(w.bin, 'oras').filter((c) => c.sub === 'push');
const tags = (w) => readLog(w.bin, 'oras').filter((c) => c.sub === 'tag');
const registryTag = (w, tag) => {
  const p = path.join(w.bin, '..', 'registry', PACKAGE.replace(/[/:]/g, '_'), 'tags', tag);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};

test('a publish: sequence 2 is pushed as v1-seq-000002, then v1 points at it', () => {
  const w = world();
  const r = publish(w);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /published: .*v1-seq-000002/);
  assert.match(r.out, /^sequence: 1 -> 2$/m);
  assert.equal(registryTag(w, 'v1'), registryTag(w, 'v1-seq-000002'));
  // The images guard ran with provenance against the methods checkout.
  const guardArgs = fs.readFileSync(path.join(w.bin, 'images-guard.log'), 'utf8');
  assert.match(guardArgs, /--require-provenance/);
  assert.match(guardArgs, new RegExp(`--methods-dir ${w.methods}`));
});

test('refuses_dirty_or_stale_app_checkout', () => {
  let w = world();
  fs.writeFileSync(path.join(w.app, 'scripts/stray.sh'), 'exit 0\n');
  let r = publish(w);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /this app checkout .* has uncommitted changes/);

  w = world();
  fs.appendFileSync(path.join(w.app, 'scripts/check-method-list.sh'), '\n# local edit\n');
  commitAll(w.app, 'local tools', false);
  r = publish(w);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /not its origin\/main/);
  assert.equal(pushes(w).length, 0);
});

test('refuses_list_not_on_methods_origin_main', () => {
  const w = world();
  const prev = path.join(w.base, 'seq2.json');
  fs.copyFileSync(path.join(w.listDir, 'method-list.json'), prev);
  assemble(w.listDir, ['--previous', prev]); // sequence 3, committed but not merged (pushed)
  commitAll(w.methods, 'list 3, unmerged', false);
  const r = publish(w);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /is not the methods repository's origin\/main copy/);
  // A dirty methods checkout is refused too.
  const w2 = world();
  fs.writeFileSync(path.join(w2.methods, 'notes.txt'), 'x\n');
  assert.match(publish(w2).out, /the methods checkout has uncommitted changes/);
});

test('refuses_source_revision_not_on_methods_main', () => {
  const w = world({ sideRevision: true });
  const r = publish(w);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /LIST_SOURCE_REVISION: commit [0-9a-f]{12} is not on the methods repository's main/);
  assert.equal(pushes(w).length, 0);
});

test('refuses_sequence_not_above_published', () => {
  // The published list is ahead.
  let w = world({ publishedSeq: 3 });
  let r = publish(w);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /sequence 2 is superseded by the published #3/);
  // The same sequence with other bytes.
  w = world({ publishedSeq: 2 });
  r = publish(w);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /sequence 2 is published with OTHER bytes/);
  assert.equal(pushes(w).length, 0);
  assert.equal(readLog(w.bin, 'minisign').length, 0);
});

test('the same list published again is a no-op', () => {
  const w = world();
  assert.equal(publish(w).status, 0);
  const before = readLog(w.bin, 'oras').length;
  const r = publish(w);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /already published: sequence 2/);
  assert.equal(readLog(w.bin, 'oras').slice(before).filter((c) => c.sub === 'push' || c.sub === 'tag').length, 0);
});

test('refuses_unresolvable_pin', () => {
  const images = readJson(path.join(LIST_DIR, 'method-env-images.json'));
  const w = world({ unpinned: images.envs[1].tag });
  const r = publish(w);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, new RegExp(`pin ghcr.io/tinnlab/txr-method-env-layers:${images.envs[1].tag} resolves to 'nothing'`));
  assert.equal(readLog(w.bin, 'minisign').length, 0);
});

test('refuses_list_without_bases', () => {
  const w = world({ noBases: true });
  const r = publish(w);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /LIST_NO_BASES/);
  assert.equal(pushes(w).length, 0);
});

test('first publish: needed when nothing is published, refused when something is', () => {
  let w = world({ publishedSeq: null });
  let r = publish(w);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /pass --first-publish/);
  r = publish(w, ['--first-publish']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /^sequence: \(none\) -> 2$/m);
  w = world();
  r = publish(w, ['--first-publish']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /--first-publish, but .* exists/);
});

test('signer_env_has_no_ghcr_token', () => {
  const w = world();
  assert.equal(publish(w).status, 0);
  const sign = readLog(w.bin, 'minisign').find((c) => c.argv.includes('-S'));
  assert.ok(sign, 'minisign -S ran');
  // PWD/SHLVL/_ come from the shell, __CF_USER_TEXT_ENCODING from macOS itself.
  const ok = ['PATH', 'HOME', 'PWD', 'SHLVL', '_', '__CF_USER_TEXT_ENCODING'];
  assert.deepEqual(sign.envKeys.filter((k) => !ok.includes(k)), []);
  assert.ok(!sign.envKeys.includes('GHCR_TOKEN') && !sign.envKeys.includes('GHCR_USER'));
  assert.ok(sign.argv.includes('txresbench-method-list format=1 sequence=2'));
  assert.ok(!JSON.stringify(sign).includes(TOKEN));
});

test('token_only_in_temp_registry_config_removed_after', () => {
  const w = world();
  assert.equal(publish(w).status, 0);
  const calls = readLog(w.bin, 'oras');
  for (const c of calls) {
    assert.ok(!c.argv.join(' ').includes(TOKEN), `token on a command line: ${c.argv.join(' ')}`);
    const authed = c.configText && c.configText.includes(Buffer.from(`maintainer:${TOKEN}`).toString('base64'));
    // The token goes to the push, the tag, and the reads of the tag being published (a
    // package's first push is private); every other read is anonymous, as an app's is.
    const ownTag = c.argv.some((a) => a.startsWith(`${PACKAGE}:v1-seq-`) || a.startsWith(`${PACKAGE}@`));
    if (c.sub === 'push' || c.sub === 'tag') {
      assert.ok(authed, `${c.sub} carries the token in its registry config`);
    } else if (authed) {
      assert.ok(ownTag, `an authenticated ${c.sub} of ${c.argv.join(' ')}`);
    } else {
      assert.equal(c.configText, '{}', `${c.sub} is anonymous (empty registry config)`);
    }
    if (authed) assert.equal(c.configMode, '600');
    assert.ok(fs.existsSync(c.config) === false, `${c.config} is removed after the run`);
    assert.ok(!c.argv.includes('login'));
  }
  assert.ok(calls.some((c) => c.sub === 'push') && calls.some((c) => c.sub === 'tag'));
  // Nothing is left in the work dir.
  assert.deepEqual(fs.readdirSync(w.base).filter((f) => f.startsWith('publish-method-list.')), []);
});

test('one_push_carries_list_and_signature', () => {
  const w = world();
  assert.equal(publish(w).status, 0);
  const p = pushes(w);
  assert.equal(p.length, 1);
  const files = p[0].argv.filter((a) => a.startsWith('method-list.json'));
  assert.deepEqual(files, [
    'method-list.json:application/vnd.txresbench.method-list.v1+json',
    'method-list.json.minisig:application/vnd.txresbench.method-list.signature.v1',
  ]);
  assert.ok(p[0].argv.includes(`${PACKAGE}:v1-seq-000002`));
  const at = p[0].argv.indexOf('--artifact-type');
  assert.equal(p[0].argv[at + 1], 'application/vnd.txresbench.method-list.v1');
  const digest = registryTag(w, 'v1-seq-000002');
  const dir = path.join(w.bin, '..', 'registry', PACKAGE.replace(/[/:]/g, '_'), 'blobs', digest.replace(':', '_'), 'files');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['method-list.json', 'method-list.json.minisig']);
  assert.ok(fs.readFileSync(path.join(dir, 'method-list.json')).equals(fs.readFileSync(path.join(w.listDir, 'method-list.json'))));
  assert.match(fs.readFileSync(path.join(dir, 'method-list.json.minisig'), 'utf8'), /^trusted comment: txresbench-method-list format=1 sequence=2$/m);
});

test('source_annotation_names_methods_repo', () => {
  const w = world();
  assert.equal(publish(w).status, 0);
  const a = pushes(w)[0].argv;
  const ann = a.filter((x, i) => a[i - 1] === '--annotation');
  assert.deepEqual(ann, [
    'org.opencontainers.image.source=https://github.com/tinnlab/txresbench-methods',
    `org.opencontainers.image.revision=${w.methodsCommit}`,
  ]);
});

test('moving_tag_set_after_immutable_tag', () => {
  const w = world();
  assert.equal(publish(w).status, 0);
  const calls = readLog(w.bin, 'oras');
  const pushAt = calls.findIndex((c) => c.sub === 'push');
  const tagAt = calls.findIndex((c) => c.sub === 'tag');
  assert.ok(pushAt >= 0 && tagAt > pushAt, 'v1 is tagged after the immutable push');
  const pushed = registryTag(w, 'v1-seq-000002');
  const tagArgs = calls[tagAt].argv.filter((x) => !x.startsWith('-') && x !== 'tag' && !x.includes('registry-config') && x !== calls[tagAt].config);
  assert.deepEqual(tagArgs, [`${PACKAGE}@${pushed}`, 'v1']);
  // Between them, v1 was re-resolved.
  assert.ok(calls.slice(pushAt, tagAt).some((c) => c.sub === 'resolve' && c.argv.includes(`${PACKAGE}:v1`)));
});

test('stops_when_v1_moved_meanwhile', () => {
  const w = world();
  fs.writeFileSync(path.join(w.bin, 'behavior.json'), JSON.stringify({ moveV1OnPush: true }));
  const r = publish(w);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /moved while this ran: it was #1 .*it is now #99/);
  assert.match(r.out, /This list \(#2\) is at .*v1-seq-000002 and v1 was NOT moved/);
  assert.equal(tags(w).length, 0);
});

test('post_push_byte_mismatch_fails_loudly', () => {
  const w = world();
  fs.writeFileSync(path.join(w.bin, 'behavior.json'), JSON.stringify({ corruptV1AfterTag: true }));
  const r = publish(w);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /!!! POST-PUSH MISMATCH: .* serves another method-list\.json/);
});

test('dry_run_touches_nothing', () => {
  const w = world();
  const before = registryTag(w, 'v1');
  const r = publish(w, ['--dry-run']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /dry run: nothing is signed or pushed/);
  assert.equal(readLog(w.bin, 'minisign').length, 0);
  assert.deepEqual(readLog(w.bin, 'oras').map((c) => c.sub).filter((s) => s !== 'resolve' && s !== 'pull'), []);
  assert.ok(readLog(w.bin, 'oras').every((c) => c.configText === '{}'), 'only anonymous reads');
  assert.equal(registryTag(w, 'v1'), before);
  assert.equal(registryTag(w, 'v1-seq-000002'), null);
});

test('a loopback rehearsal: plain HTTP to 127.0.0.1, no token; --keys only there', () => {
  const w = world();
  // Re-seed the registry under the loopback host.
  const images = readJson(path.join(w.listDir, 'method-env-images.json'));
  for (const e of [...images.bases, ...images.envs]) {
    seedArtifact(w.bin, e.oci_ref.replace('ghcr.io', '127.0.0.1:5055'), e.tag, { f: Buffer.from('x') }, e.digest);
  }
  seedArtifact(w.bin, PACKAGE.replace('ghcr.io', '127.0.0.1:5055'), 'v1', {
    'method-list.json': w.published,
    'method-list.json.minisig': stubSignature(w.published, 'txresbench-method-list format=1 sequence=1'),
  }, `sha256:${'a'.repeat(64)}`);
  const r = publish(w, ['--registry', '127.0.0.1:5055'], { GHCR_TOKEN: '' });
  assert.equal(r.status, 0, r.out);
  const calls = readLog(w.bin, 'oras');
  assert.ok(calls.every((c) => c.plain && c.configText === '{}'));
  assert.ok(calls.every((c) => c.argv.some((a) => a.startsWith('127.0.0.1:5055/'))));
  const bad = publish(world(), ['--keys', path.join(REPO, 'scripts/method-list/fixtures/fixture-keys.json')]);
  assert.equal(bad.status, 2, bad.out);
  assert.match(bad.out, /--keys .* is for a loopback rehearsal only/);
  assert.equal(publish(world(), ['--registry', 'ghcr.io:443']).status, 2);
});

test('a first push into a private package stops before v1; the rerun only moves v1', () => {
  const w = world({ publishedSeq: null });
  fs.writeFileSync(path.join(w.bin, 'behavior.json'), JSON.stringify({ privateUntilPublic: true }));
  let r = publish(w, ['--first-publish']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /pushed but not readable anonymously\. A new package starts private/);
  assert.equal(registryTag(w, 'v1'), null);
  assert.equal(pushes(w).length, 1);
  fs.writeFileSync(path.join(w.bin, 'behavior.json'), '{}'); // the owner made it public
  r = publish(w, ['--first-publish']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /already holds these bytes .*not pushed again/);
  assert.equal(pushes(w).length, 1);
  assert.equal(registryTag(w, 'v1'), registryTag(w, 'v1-seq-000002'));
});

test('a key file readable by others is refused before signing', () => {
  const w = world();
  fs.chmodSync(w.key, 0o644);
  const r = publish(w);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /is readable by others \(mode 644\)/);
  assert.equal(readLog(w.bin, 'minisign').length, 0);
});
