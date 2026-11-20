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

import { STUB_KEY, readLog, seedArtifact, stubSignature, writeCargoStub, writeStubs } from './method-list/stubs.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIST_DIR = path.join(REPO, 'scripts/method-list/fixtures/list-dir');
const PACKAGE = 'ghcr.io/tinnlab/txresbench-method-list';
const TOKEN = 'ghp_stubtoken0123456789';
const APP_URL = 'https://github.com/tinnlab/txresbench-app';
const METHODS_URL = 'https://github.com/tinnlab/txresbench-methods';
const UNTRUSTED_KEY_ID = '0707070707070707';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'publish-method-list-'));
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, v, indent = 2) => fs.writeFileSync(p, JSON.stringify(v, null, indent) + '\n');

// The checkouts' origin is the real repository URL; a git config of this test (in place of
// the user's global one) sends it to a local bare repository (url.<bare>.insteadOf).
let gitConfig = null;
function sh(cmd, args, opts = {}) {
  const env = { ...process.env, ...(gitConfig ? { GIT_CONFIG_GLOBAL: gitConfig } : {}), ...(opts.env || {}) };
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts, env });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stdout}${r.stderr}`);
  return r.stdout.trim();
}
const git = (dir, ...args) =>
  sh('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args]);

function initRepo(dir, url) {
  fs.mkdirSync(dir, { recursive: true });
  sh('git', ['init', '-q', '-b', 'main', dir]);
  const origin = `${dir}-origin.git`;
  sh('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  sh('git', ['config', '-f', gitConfig, `url.${origin}.insteadOf`, url]);
  git(dir, 'remote', 'add', 'origin', url);
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
 * The world of one test. Defaults: the published :v2 holds sequence 1, the methods main
 * holds sequence 2, every pin resolves.
 */
function world({ publishedSeq = 1, otherBytes = false, noBases = false, sideRevision = false, unpinned = null,
  publishedKey = STUB_KEY.key_id, publishedExtraRow = false, seqTags = [], appUrl = APP_URL,
  methodsUrl = METHODS_URL } = {}) {
  const base = tmp();
  gitConfig = path.join(base, 'gitconfig');
  fs.writeFileSync(gitConfig, '');
  const bin = path.join(base, 'bin');
  const stubs = writeStubs(bin);
  // The stand-in for the keys compiled into the app (the stub txresbench reads it).
  writeJson(path.join(bin, 'trusted-keys.json'),
    { format: 'txresbench-method-list-keys', format_version: 1, keys: [STUB_KEY] }, 1);

  // The app checkout: the tools under test + the trusted keys holding the stub key.
  const app = path.join(base, 'app');
  initRepo(app, appUrl);
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
  initRepo(methods, methodsUrl);
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
    published = withSequence(seq1, publishedSeq);
    if (otherBytes) {
      published = Buffer.from(published.toString('utf8').replace('"assembled_at": "2026-01-01T00:00:00Z"',
        '"assembled_at": "2026-01-01T00:00:01Z"'));
    }
    if (publishedExtraRow) published = withExtraRow(published, 'fx-only-in-the-published-list');
    seedArtifact(bin, PACKAGE, 'v2', {
      'method-list.json': published,
      'method-list.json.minisig': stubSignature(published, `txresbench-method-list format=2 sequence=${publishedSeq}`,
        publishedKey),
    }, `sha256:${'a'.repeat(64)}`);
  }
  // Earlier immutable tags: v2-seq-<n>, each signed by `keyId`.
  for (const { seq, keyId = STUB_KEY.key_id } of seqTags) {
    const bytes = withSequence(seq1, seq);
    seedArtifact(bin, PACKAGE, `v2-seq-${String(seq).padStart(6, '0')}`, {
      'method-list.json': bytes,
      'method-list.json.minisig': stubSignature(bytes, `txresbench-method-list format=2 sequence=${seq}`, keyId),
    }, `sha256:${String(seq).padStart(2, '0').repeat(32)}`);
  }
  const key = path.join(base, 'secret.key');
  fs.writeFileSync(key, 'stub secret key\n', { mode: 0o600 });
  return { base, bin, stubs, app, methods, listDir, key, methodsCommit, published, gitConfig };
}

/** The list with one more catalogue row (written in Python: keeps 0.0). */
function withExtraRow(bytes, id) {
  const r = spawnSync('python3', ['-c', `import copy, json, sys
d = json.loads(sys.stdin.read())
row = copy.deepcopy(d['catalogue']['methods'][0])
row['id'] = sys.argv[1]
d['catalogue']['methods'].append(row)
sys.stdout.write(json.dumps(d, indent=1, sort_keys=True, ensure_ascii=False) + '\\n')`, id], { input: bytes, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return Buffer.from(r.stdout);
}

/** The list with another sequence: a text edit (a JSON round trip in JavaScript would print 0.0
 * as 0, another value to the rules). */
function withSequence(bytes, sequence) {
  const text = bytes.toString('utf8');
  assert.match(text, /^ "sequence": \d+$/m);
  return Buffer.from(text.replace(/^ "sequence": \d+$/m, ` "sequence": ${sequence}`));
}

function publish(w, extra = [], env = {}, { cli = true, cwd } = {}) {
  const fullEnv = { ...process.env, PATH: `${w.bin}:${process.env.PATH}`, GHCR_USER: 'maintainer', GHCR_TOKEN: TOKEN,
    TMPDIR: w.base, PYTHONDONTWRITEBYTECODE: '1', GIT_CONFIG_GLOBAL: w.gitConfig, ...env };
  for (const [k, v] of Object.entries(fullEnv)) if (v === undefined) delete fullEnv[k];
  const r = spawnSync('bash', [path.join(w.app, 'scripts/publish-method-list.sh'), '--methods-dir', w.methods,
    '--key', w.key, ...(cli ? ['--cli', w.stubs.txresbench] : []), ...extra], { encoding: 'utf8', env: fullEnv, cwd });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
const pushes = (w) => readLog(w.bin, 'oras').filter((c) => c.sub === 'push');
const tags = (w) => readLog(w.bin, 'oras').filter((c) => c.sub === 'tag');
const registryTag = (w, tag) => {
  const p = path.join(w.bin, '..', 'registry', PACKAGE.replace(/[/:]/g, '_'), 'tags', tag);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};

test('a publish: sequence 2 is pushed as v2-seq-000002, then v2 points at it', () => {
  const w = world();
  const r = publish(w);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /published: .*v2-seq-000002/);
  assert.match(r.out, /^sequence: 1 -> 2$/m);
  assert.equal(registryTag(w, 'v2'), registryTag(w, 'v2-seq-000002'));
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
  w = world({ publishedSeq: 2, otherBytes: true });
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
  assert.ok(sign.argv.includes('txresbench-method-list format=2 sequence=2'));
  assert.ok(!JSON.stringify(sign).includes(TOKEN));
});

test('token_only_in_temp_registry_config_removed_after', () => {
  const w = world();
  assert.equal(publish(w).status, 0);
  const calls = readLog(w.bin, 'oras');
  for (const c of calls) {
    assert.ok(!c.argv.join(' ').includes(TOKEN), `token on a command line: ${c.argv.join(' ')}`);
    assert.equal(c.tokenInEnv, false, `oras ${c.sub} got GHCR_TOKEN in its environment`);
    const authed = c.configText && c.configText.includes(Buffer.from(`maintainer:${TOKEN}`).toString('base64'));
    // The token goes to the push, the tag, and the reads of the tag being published (a
    // package's first push is private); every other read is anonymous, as an app's is.
    const ownTag = c.argv.some((a) => a.startsWith(`${PACKAGE}:v2-seq-`) || a.startsWith(`${PACKAGE}@`));
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
  assert.ok(p[0].argv.includes(`${PACKAGE}:v2-seq-000002`));
  const at = p[0].argv.indexOf('--artifact-type');
  assert.equal(p[0].argv[at + 1], 'application/vnd.txresbench.method-list.v1');
  const digest = registryTag(w, 'v2-seq-000002');
  const dir = path.join(w.bin, '..', 'registry', PACKAGE.replace(/[/:]/g, '_'), 'blobs', digest.replace(':', '_'), 'files');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['method-list.json', 'method-list.json.minisig']);
  assert.ok(fs.readFileSync(path.join(dir, 'method-list.json')).equals(fs.readFileSync(path.join(w.listDir, 'method-list.json'))));
  assert.match(fs.readFileSync(path.join(dir, 'method-list.json.minisig'), 'utf8'), /^trusted comment: txresbench-method-list format=2 sequence=2$/m);
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
  assert.ok(pushAt >= 0 && tagAt > pushAt, 'v2 is tagged after the immutable push');
  const pushed = registryTag(w, 'v2-seq-000002');
  const tagArgs = calls[tagAt].argv.filter((x) => !x.startsWith('-') && x !== 'tag' && !x.includes('registry-config') && x !== calls[tagAt].config);
  assert.deepEqual(tagArgs, [`${PACKAGE}@${pushed}`, 'v2']);
  // Between them, v2 was re-resolved.
  assert.ok(calls.slice(pushAt, tagAt).some((c) => c.sub === 'resolve' && c.argv.includes(`${PACKAGE}:v2`)));
});

test('stops_when_v1_moved_meanwhile', () => {
  const w = world();
  fs.writeFileSync(path.join(w.bin, 'behavior.json'), JSON.stringify({ moveV1OnPush: 'verified' }));
  const r = publish(w);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /moved while this ran: it was #1 .*it is now #99/);
  assert.match(r.out, /This list \(#2\) is at .*v2-seq-000002 and v2 was NOT moved/);
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
  const before = registryTag(w, 'v2');
  const r = publish(w, ['--dry-run']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /dry run: nothing is signed or pushed/);
  assert.equal(readLog(w.bin, 'minisign').length, 0);
  assert.deepEqual(readLog(w.bin, 'oras').map((c) => c.sub).filter((s) => s !== 'resolve' && s !== 'pull'), []);
  assert.ok(readLog(w.bin, 'oras').every((c) => c.configText === '{}'), 'only anonymous reads');
  assert.equal(registryTag(w, 'v2'), before);
  assert.equal(registryTag(w, 'v2-seq-000002'), null);
});

test('a loopback rehearsal: plain HTTP to 127.0.0.1, no token; --keys only there', () => {
  const w = world();
  // Re-seed the registry under the loopback host.
  const images = readJson(path.join(w.listDir, 'method-env-images.json'));
  for (const e of [...images.bases, ...images.envs]) {
    seedArtifact(w.bin, e.oci_ref.replace('ghcr.io', '127.0.0.1:5055'), e.tag, { f: Buffer.from('x') }, e.digest);
  }
  seedArtifact(w.bin, PACKAGE.replace('ghcr.io', '127.0.0.1:5055'), 'v2', {
    'method-list.json': w.published,
    'method-list.json.minisig': stubSignature(w.published, 'txresbench-method-list format=2 sequence=1'),
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

test('a first push into a private package stops before v2; the rerun only moves v2', () => {
  const w = world({ publishedSeq: null });
  fs.writeFileSync(path.join(w.bin, 'behavior.json'), JSON.stringify({ privateUntilPublic: true }));
  let r = publish(w, ['--first-publish']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /pushed but not readable anonymously\. A new package starts private/);
  assert.equal(registryTag(w, 'v2'), null);
  assert.equal(pushes(w).length, 1);
  fs.writeFileSync(path.join(w.bin, 'behavior.json'), '{}'); // the owner made it public
  r = publish(w, ['--first-publish']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /already holds these bytes .*not pushed again/);
  assert.equal(pushes(w).length, 1);
  assert.equal(registryTag(w, 'v2'), registryTag(w, 'v2-seq-000002'));
});

test('a key file readable by others is refused before signing', () => {
  const w = world();
  fs.chmodSync(w.key, 0o644);
  const r = publish(w);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /is readable by others \(mode 644\)/);
  assert.equal(readLog(w.bin, 'minisign').length, 0);
});

// ── the published list must verify; a list that does not is superseded only on purpose ──

test('refuses_published_list_that_does_not_verify', () => {
  const w = world({ publishedKey: UNTRUSTED_KEY_ID });
  const r = publish(w);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /v2 \(sha256:a{64}\) does not verify with this app's trusted keys/);
  assert.match(r.out, /METHOD_LIST_UNKNOWN_KEY/);
  assert.match(r.out, /--supersede-unverified sha256:a{64}/);
  assert.equal(pushes(w).length, 0);
  assert.equal(readLog(w.bin, 'minisign').length, 0);
});

test('--supersede-unverified: the floor is the highest v2-seq-* list that verifies', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  // v2 (#5) and v2-seq-000005 are signed by a key the app does not trust; #1 verifies.
  let w = world({ publishedKey: UNTRUSTED_KEY_ID, publishedSeq: 5,
    seqTags: [{ seq: 1 }, { seq: 5, keyId: UNTRUSTED_KEY_ID }] });
  let r = publish(w, ['--supersede-unverified', `sha256:${'b'.repeat(64)}`]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /is not the current .*:v2 \(sha256:a{64}\)/);
  r = publish(w, ['--supersede-unverified', digest]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /v2-seq-000005 does not verify/);
  assert.match(r.out, /sequence floor: #1 \(v2-seq-000001\)/);
  assert.match(r.out, /^sequence: 1 -> 2$/m);
  assert.equal(registryTag(w, 'v2'), registryTag(w, 'v2-seq-000002'));
  // A verified tag at or above the local sequence still wins.
  w = world({ publishedKey: UNTRUSTED_KEY_ID, publishedSeq: 5, seqTags: [{ seq: 3 }] });
  r = publish(w, ['--supersede-unverified', digest]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /sequence 2 is superseded by the published #3/);
  // The flag is refused when v2 verifies.
  w = world();
  r = publish(w, ['--supersede-unverified', digest]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /verifies: --supersede-unverified is only for a v2 that does not/);
});

test('refuses_list_dropping_a_published_row', () => {
  const w = world({ publishedExtraRow: true });
  const r = publish(w);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /LIST_ROW_REMOVED: .*'fx-only-in-the-published-list'/);
  assert.match(r.out, /does not keep the published list's rows and facts/);
  assert.equal(pushes(w).length, 0);
});

// ── the token, the verifier, the origins ─────────────────────────────────────────

test('no child process sees GHCR_TOKEN', () => {
  const w = world();
  writeCargoStub(w.bin, w.stubs.txresbench);
  const r = publish(w, [], { TXR_CLI: undefined }, { cli: false });
  assert.equal(r.status, 0, r.out);
  for (const name of ['oras', 'cli', 'cargo']) {
    const calls = readLog(w.bin, name);
    assert.ok(calls.length > 0, `${name} ran`);
    for (const c of calls) assert.equal(c.tokenInEnv, false, `${name} ${c.argv.join(' ')} got GHCR_TOKEN`);
  }
  for (const c of readLog(w.bin, 'minisign')) assert.ok(!c.envKeys.includes('GHCR_TOKEN'));
});

test('a TXR_CLI left in the environment is refused; --cli names the verifier', () => {
  const w = world();
  const r = publish(w, [], { TXR_CLI: w.stubs.txresbench }, { cli: false });
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /TXR_CLI is set .* pass --cli/);
  assert.equal(readLog(w.bin, 'oras').length, 0);
});

test('the default verifier is cargo run in the app checkout, wherever the publisher is started', () => {
  const w = world();
  writeCargoStub(w.bin, w.stubs.txresbench);
  const r = publish(w, [], { TXR_CLI: undefined }, { cli: false, cwd: w.base });
  assert.equal(r.status, 0, r.out);
  const calls = readLog(w.bin, 'cargo');
  assert.ok(calls.length >= 3, 'the loader check, the published list, the new list');
  for (const c of calls) {
    assert.equal(fs.realpathSync(c.cwd), fs.realpathSync(w.app));
    assert.deepEqual(c.argv.slice(0, 6), ['run', '--quiet', '--manifest-path',
      path.join(w.app, 'src-app/server/Cargo.toml'), '--bin', 'txresbench']);
  }
});

test('refuses an origin that is not the tinnlab repository (a fork)', () => {
  let w = world({ methodsUrl: 'https://github.com/someone/txresbench-methods' });
  let r = publish(w);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /origin of the methods checkout is https:\/\/github\.com\/someone\/txresbench-methods, not tinnlab\/txresbench-methods/);
  w = world({ appUrl: 'https://github.com/someone/txresbench-app.git' });
  r = publish(w);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /origin of this app checkout is .*someone.*, not tinnlab\/txresbench-app/);
  assert.equal(pushes(w).length, 0);
  // The ssh spellings of the right repositories pass.
  w = world({ methodsUrl: 'git@github.com:tinnlab/txresbench-methods.git', appUrl: 'ssh://git@github.com/tinnlab/txresbench-app.git' });
  r = publish(w);
  assert.equal(r.status, 0, r.out);
});

// ── the immutable tag and the moving one ───────────────────────────────────────

test('does_not_push_over_a_tag_it_cannot_read', () => {
  const w = world();
  fs.writeFileSync(path.join(w.bin, 'behavior.json'), JSON.stringify({ resolveError: ['v2-seq-000002'] }));
  const r = publish(w);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /cannot tell whether .*:v2-seq-000002 exists/);
  assert.match(r.out, /unexpected status code 500/);
  assert.equal(pushes(w).length, 0);
});

test('v1_moves_only_after_the_pushed_artifact_reads_back', () => {
  const w = world();
  fs.writeFileSync(path.join(w.bin, 'behavior.json'), JSON.stringify({ corruptReadback: true }));
  const r = publish(w);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /v2-seq-000002 reads back with other bytes \(method-list\.json\); v2 was NOT moved/);
  assert.equal(tags(w).length, 0);
  assert.equal(registryTag(w, 'v2'), `sha256:${'a'.repeat(64)}`);
});

test('a_moved_v1_that_does_not_verify_is_not_read', () => {
  const w = world();
  fs.writeFileSync(path.join(w.bin, 'behavior.json'), JSON.stringify({ moveV1OnPush: 'unverified' }));
  const r = publish(w);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /moved while this ran: it was #1 .*it is now a list that does not verify/);
  assert.doesNotMatch(r.out, /#99/);
  assert.equal(tags(w).length, 0);
});
