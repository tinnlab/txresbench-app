#!/usr/bin/env node
// publish-method-env-images.test.mjs — the controls for
// `scripts/publish-method-env-images.sh` (B2 / B11 of the publish-scripts
// hardening: a resolve failure that is not a clear "not found" must stop the
// run instead of being taken for "tag absent", and the GHCR token must reach
// oras only through a temporary mode-600 registry config — never `oras login`,
// never a child process's environment).
//
// Style: scripts/publish-method-list.test.mjs — the REAL publisher runs as a
// subprocess with a stub `oras` on PATH. The stub is a registry in
// <bin>/../registry (tags → digests, blobs by content), it logs every call
// with the content/mode of the --registry-config it was given and whether
// GHCR_TOKEN was in its environment, and `behavior.json` makes a named tag's
// resolve fail with a 5xx-style error. No network, no real registry, no real
// token. The publisher's manifest guard is stubbed (its own controls are
// scripts/check-method-env-images.test.mjs); every other check of the
// publisher — the byte contract, the record equality, the guard plumbing — is
// the real code.
//
// The tiny layer is built by the test itself (a real sha256, a real
// oci-manifest digest, an artifact.json the publisher's record checks pass),
// so the end-to-end path is the otherwise-full one: manifest → byte checks →
// (stubbed) guard → auth config → tag resolve → base resolve → blob/manifest
// push → post-push resolve witness → sign. The skip-sign runs cover the
// push paths; one test (5) runs WITHOUT --skip-sign with a stub `cosign` on
// PATH — the release-path signing step — and asserts the private
// DOCKER_CONFIG it is handed (the token's ghcr.io config, no GHCR_TOKEN/
// GHCR_USER in its environment, the user's own Docker config untouched, the
// private dir removed on exit).
//
//   node --test scripts/publish-method-env-images.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLISHER = path.join(REPO, 'scripts/publish-method-env-images.sh');
const LAYER_OCI = 'ghcr.io/tinnlab/txr-method-env-layers';
const BASE_OCI = 'ghcr.io/tinnlab/txresbench-env';
const TOKEN = 'ghp_stubtoken0123456789';
const USER = 'maintainer';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'publish-method-env-images-'));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** The stub oras (a node script): a content-addressed registry under
 *  <bin>/../registry, plus the call log `oras.log`. `manifest push` digests
 *  the manifest FILE bytes it is given (a registry stores what it receives),
 *  so the post-push resolve witnesses the same bytes the staged
 *  oci-manifest.json hashed to. `login` is not implemented: a publish that
 *  calls it fails loudly AND is visible in the log. */
const ORAS = String.raw`#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const BIN = path.dirname(new URL(import.meta.url).pathname);
const REG = path.join(BIN, '..', 'registry');
const behavior = fs.existsSync(path.join(BIN, 'behavior.json')) ? JSON.parse(fs.readFileSync(path.join(BIN, 'behavior.json'), 'utf8')) : {};
const argv = process.argv.slice(2);
const sub = argv[0];
const pos = []; let config = null; let plain = false;
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--registry-config') config = argv[++i];
  else if (a === '--plain-http') plain = true;
  else pos.push(a);
}
let configText = null; let configMode = null;
if (config && fs.existsSync(config)) {
  configText = fs.readFileSync(config, 'utf8');
  configMode = (fs.statSync(config).mode & 0o777).toString(8);
}
fs.appendFileSync(path.join(BIN, 'oras.log'), JSON.stringify({
  sub, argv, cwd: process.cwd(), config, configText, configMode, plain,
  tokenInEnv: 'GHCR_TOKEN' in process.env,
}) + '\n');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const split = (ref) => {
  const at = ref.indexOf('@');
  if (at >= 0) return { repo: ref.slice(0, at), digest: ref.slice(at + 1) };
  const slash = ref.lastIndexOf('/'); const colon = ref.lastIndexOf(':');
  if (colon > slash) return { repo: ref.slice(0, colon), tag: ref.slice(colon + 1) };
  return { repo: ref, tag: 'latest' };
};
const repoDir = (repo) => path.join(REG, repo.replace(/[/:]/g, '_'));
const tagFile = (repo, tag) => path.join(repoDir(repo), 'tags', tag);
const fail = (m) => { process.stderr.write('Error: ' + m + '\n'); process.exit(1); };
const resolveDigest = (ref) => {
  const r = split(ref);
  if (r.digest) return fs.existsSync(path.join(repoDir(r.repo), 'blobs', r.digest.replace(':', '_'))) ? r.digest : null;
  return fs.existsSync(tagFile(r.repo, r.tag)) ? fs.readFileSync(tagFile(r.repo, r.tag), 'utf8').trim() : null;
};
if (sub === 'login') {
  fail('stub oras: oras login is forbidden (the token goes in a temp registry config)');
} else if (sub === 'resolve') {
  const ref = pos[0];
  const r = split(ref);
  if ((behavior.resolveError || []).includes(r.tag)) fail('GET ' + ref + ': unexpected status code 500');
  const d = resolveDigest(ref);
  if (!d) fail('not found: ' + ref);
  process.stdout.write(d + '\n');
} else if (sub === 'blob' && pos[0] === 'push') {
  const r = split(pos[1]);
  const file = pos[2];
  const bytes = fs.readFileSync(path.resolve(process.cwd(), file));
  const d = 'sha256:' + sha(bytes);
  const blob = path.join(repoDir(r.repo), 'blobs', d.replace(':', '_'));
  fs.mkdirSync(path.join(blob, 'files'), { recursive: true });
  fs.writeFileSync(path.join(blob, 'files', path.basename(file)), bytes);
  process.stdout.write('Pushed ' + pos[1] + '\nDigest: ' + d + '\n');
} else if (sub === 'manifest' && pos[0] === 'push') {
  const ref = pos[1];
  const r = split(ref);
  const file = pos[2];
  const bytes = fs.readFileSync(file);
  const d = 'sha256:' + sha(bytes);
  const blob = path.join(repoDir(r.repo), 'blobs', d.replace(':', '_'));
  fs.mkdirSync(blob, { recursive: true });
  fs.writeFileSync(path.join(blob, 'manifest.json'), bytes);
  fs.mkdirSync(path.dirname(tagFile(r.repo, r.tag)), { recursive: true });
  fs.writeFileSync(tagFile(r.repo, r.tag), d);
  process.stdout.write('Pushed ' + ref + '\nDigest: ' + d + '\n');
} else {
  fail('stub oras: unsupported ' + argv.join(' '));
}
`;

/** The stub cosign: records the call and the signing environment — argv,
 *  DOCKER_CONFIG, the config.json at its config dir, and whether GHCR_TOKEN /
 *  GHCR_USER leaked into its environment — as one JSON line per invocation in
 *  `cosign.log`, then succeeds. It never talks to a registry and never reads
 *  or writes the user's own Docker config: everything the signing assertions
 *  check is in that log. */
const COSIGN = String.raw`#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const BIN = path.dirname(new URL(import.meta.url).pathname);
const dockerConfig = process.env.DOCKER_CONFIG || '';
const cfgPath = path.join(dockerConfig, 'config.json');
const configJson = dockerConfig && fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf8') : null;
fs.appendFileSync(path.join(BIN, 'cosign.log'), JSON.stringify({
  argv: process.argv.slice(2),
  dockerConfig,
  configJson,
  tokenInEnv: 'GHCR_TOKEN' in process.env,
  userInEnv: 'GHCR_USER' in process.env,
}) + '\n');
`;

/** Put an artifact at `<repo>:<tag>` in the stub registry (the tag names the
 *  given digest; the files are stored under it). */
function seedArtifact(bin, repo, tag, files, digest) {
  const dir = path.join(bin, '..', 'registry', repo.replace(/[/:]/g, '_'));
  const blob = path.join(dir, 'blobs', digest.replace(':', '_'));
  fs.mkdirSync(path.join(blob, 'files'), { recursive: true });
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(blob, 'files', name), bytes);
  fs.mkdirSync(path.join(dir, 'tags'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tags', tag), digest);
}

/** The JSON lines of the oras.log (empty when the stub never ran). */
function readLog(bin) {
  const p = path.join(bin, 'oras.log');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** The world of one test: a copy of the REAL publisher in a throwaway app
 *  checkout (only its manifest guard is stubbed), the staged artifact the
 *  publisher will verify byte-for-byte, the manifest contract, and a stub
 *  registry holding the published base. `seedLayer`: 'identical' puts the
 *  entry's own digest at the tag, 'other' puts a different one; `errorTag` /
 *  `errorBase`: that tag answers resolve with a 5xx-style error. */
function world({ seedLayer = null, errorTag = false, errorBase = false } = {}) {
  const base = tmp();
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'oras'), ORAS);
  fs.chmodSync(path.join(bin, 'oras'), 0o755);

  // The app checkout: the publisher under test + a stub for its manifest guard.
  const app = path.join(base, 'app');
  fs.mkdirSync(path.join(app, 'scripts'), { recursive: true });
  fs.copyFileSync(PUBLISHER, path.join(app, 'scripts/publish-method-env-images.sh'));
  fs.chmodSync(path.join(app, 'scripts/publish-method-env-images.sh'), 0o755);
  fs.writeFileSync(path.join(app, 'scripts/check-method-env-images.sh'),
    "#!/usr/bin/env bash\n# stub: the manifest guard's own controls are scripts/check-method-env-images.test.mjs\nexit 0\n");
  fs.chmodSync(path.join(app, 'scripts/check-method-env-images.sh'), 0o755);

  // The staged artifact (a real file, a real digest) + the manifest contract.
  const staging = path.join(base, 'staged');
  const dir = path.join(staging, 'layers', 'fixture-a-amd64');
  fs.mkdirSync(dir, { recursive: true });
  const layerSquash = Buffer.from('fixture layer bytes — a real sha256 and a real size\n');
  const layerSha = sha256(layerSquash);
  fs.writeFileSync(path.join(dir, 'layer.squashfs'), layerSquash);
  const ociManifest = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { mediaType: 'application/vnd.oci.empty.v1+json',
      digest: 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', size: 2 },
    layers: [{ mediaType: 'application/vnd.txr.method-env.layer.v1',
      digest: `sha256:${layerSha}`, size: layerSquash.length }],
    artifactType: 'application/vnd.txr.method-env.layer.v1',
  }, null, 2) + '\n');
  const layerDigest = `sha256:${sha256(ociManifest)}`;
  fs.writeFileSync(path.join(dir, 'oci-manifest.json'), ociManifest);
  const tag = `fixture-a-1.0.0-amd64-${layerSha.slice(0, 12)}`;
  fs.writeFileSync(path.join(dir, 'artifact.json'), JSON.stringify({
    env_id: 'fixture-a', method_id: 'fixture-a', method_version: '1.0.0', arch: 'amd64',
    oci_ref: LAYER_OCI, tag,
    layer_sha256: layerSha, size_bytes: layerSquash.length,
    source_revision: 'deadbeef1234', layer_file: 'layer.squashfs',
    record_schema_version: '1', generator_version: '0.6.0',
  }, null, 2) + '\n');

  // The commit contract: one layer entry + one base record (the language
  // family's base, published first).
  const baseSha = 'b'.repeat(64);
  const manifest = {
    format: 'txr-method-env-images', format_version: 1,
    bases: [{
      base_id: 'base-py', arch: 'amd64', oci_ref: BASE_OCI,
      tag: `base-py-2.0-amd64-${baseSha.slice(0, 12)}`,
      digest: `sha256:${'a'.repeat(64)}`, squashfs_sha256: baseSha, size_bytes: 3,
      source_ref: 'ghcr.io/tinnlab/txresbench-base-py:2.0',
      source_digest: `sha256:${'c'.repeat(64)}`, contract: '2.0',
    }],
    envs: [{
      env_id: 'fixture-a', method_id: 'fixture-a', method_version: '1.0.0', language: 'Python',
      arch: 'amd64', oci_ref: LAYER_OCI, tag,
      digest: layerDigest, layer_sha256: layerSha, size_bytes: layerSquash.length,
      base_ref: 'ghcr.io/tinnlab/txresbench-base-py:2.0', base_digest: `sha256:${'c'.repeat(64)}`,
      contract: '2.0', layer_schema: 1, source_revision: 'deadbeef1234',
      source_tree: 'a'.repeat(40), generator_version: '0.6.0',
    }],
  };
  const manifestPath = path.join(base, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  // The published base: its tag resolves to the record's digest.
  seedArtifact(bin, BASE_OCI, manifest.bases[0].tag,
    { 'base.squashfs': Buffer.from('base') }, manifest.bases[0].digest);
  if (seedLayer === 'identical') {
    seedArtifact(bin, LAYER_OCI, tag, { f: Buffer.from('x') }, layerDigest);
  } else if (seedLayer === 'other') {
    seedArtifact(bin, LAYER_OCI, tag, { f: Buffer.from('x') }, `sha256:${'42'.repeat(32)}`);
  }
  const errors = [];
  if (errorTag) errors.push(tag);
  if (errorBase) errors.push(manifest.bases[0].tag);
  if (errors.length > 0) {
    fs.writeFileSync(path.join(bin, 'behavior.json'), JSON.stringify({ resolveError: errors }));
  }

  return {
    base, bin, app, staging, methodsDir: path.join(base, 'methods'), manifestPath,
    entry: manifest.envs[0], baseRecord: manifest.bases[0],
    layerSha, layerDigest, tag,
  };
}

/** Run the real publisher over the world. `--skip-sign` is passed (so no
 *  cosign is needed) unless `opts.skipSign` is false — the release-path
 *  signing run, which needs a stub `cosign` on PATH. The stub `oras` is the
 *  only tool the test puts on PATH by default. */
function publish(w, extra = [], env = {}, { skipSign = true } = {}) {
  const fullEnv = { ...process.env, PATH: `${w.bin}:${process.env.PATH}`,
    GHCR_USER: USER, GHCR_TOKEN: TOKEN, TMPDIR: w.base,
    PYTHONDONTWRITEBYTECODE: '1', ...env };
  for (const [k, v] of Object.entries(fullEnv)) if (v === undefined) delete fullEnv[k];
  const r = spawnSync('bash', [
    path.join(w.app, 'scripts/publish-method-env-images.sh'),
    '--env', 'fixture-a', '--manifest', w.manifestPath, '--staging-dir', w.staging,
    '--methods-dir', w.methodsDir, ...(skipSign ? ['--skip-sign'] : []), ...extra,
  ], { encoding: 'utf8', env: fullEnv });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

// ── (1) a resolve that fails with a 5xx-style error is refused, nothing pushed ──

test('resolve_error_is_refused_and_nothing_is_pushed', (t) => {
  const w = world({ errorTag: true }); // the layer tag's resolve answers 500
  t.after(() => fs.rmSync(w.base, { recursive: true, force: true }));
  const r = publish(w);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /could not read the tag/);
  assert.match(r.out, /This is not 'not found', so the tag is NOT taken for absent/);
  const c = readLog(w.bin);
  assert.ok(c.length > 0, 'the tag was resolved');
  assert.ok(c.every((x) => x.sub === 'resolve'), 'nothing but a resolve happened');
  assert.ok(c.some((x) => x.argv.includes('--registry-config')), 'the resolve carried an explicit registry config');
});

test('base_resolve_error_is_refused_and_nothing_is_pushed', (t) => {
  // The layer tag is free ("not found"); the BASE's resolve answers 500 — the
  // same rule as the tag: an unreadable base is never taken for an absent one.
  const w = world({ errorBase: true });
  t.after(() => fs.rmSync(w.base, { recursive: true, force: true }));
  const r = publish(w);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /could not read the base/);
  assert.match(r.out, /This is not 'not found', so the base is NOT taken for absent/);
  assert.ok(readLog(w.bin).every((x) => x.sub === 'resolve'), 'nothing but resolves happened');
});

// ── (2) a clear "not found" means the tag is free: the push proceeds ──────────

test('not_found_proceeds_to_the_push', (t) => {
  const w = world(); // the layer tag is absent from the stub registry
  t.after(() => fs.rmSync(w.base, { recursive: true, force: true }));
  const r = publish(w);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, new RegExp(`published : ${LAYER_OCI}:${w.tag} @ ${w.layerDigest}`));
  const c = readLog(w.bin);
  assert.ok(c.some((x) => x.sub === 'blob' && x.argv[1] === 'push'), 'the layer blob was pushed');
  assert.ok(c.some((x) => x.sub === 'manifest' && x.argv[1] === 'push'), 'the manifest bytes were pushed');
  assert.ok(c.some((x) => x.sub === 'resolve' && x.argv.includes(`${LAYER_OCI}:${w.tag}`)), 'post-push witness ran');
  // The first resolve answered "not found" (recorded as a failure in the stub),
  // yet the run went on — the opposite of test (1).
  assert.ok(c.filter((x) => x.sub === 'resolve').length >= 2, 'resolves happened before and after the push');
});

// ── (3a) an existing identical digest is a safe no-op republish ───────────────

test('identical_existing_digest_is_a_noop_republish', (t) => {
  const w = world({ seedLayer: 'identical' });
  t.after(() => fs.rmSync(w.base, { recursive: true, force: true }));
  const r = publish(w);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /already names .*identical bytes — re-publishing/);
  // The publisher re-publishes the same bytes (the message says so); the tag
  // that results is still the pinned digest — a republish, never a refusal.
  const c = readLog(w.bin);
  assert.ok(c.some((x) => x.sub === 'blob' && x.argv[1] === 'push'), 'the identical bytes were re-pushed');
  assert.equal(
    fs.readFileSync(path.join(w.bin, '..', 'registry', LAYER_OCI.replace(/[/:]/g, '_'), 'tags', w.tag), 'utf8').trim(),
    w.layerDigest,
  );
});

// ── (3b) a different digest is refused (the pre-existing behaviour) ───────────

test('different_existing_digest_is_refused', (t) => {
  const w = world({ seedLayer: 'other' });
  t.after(() => fs.rmSync(w.base, { recursive: true, force: true }));
  const r = publish(w);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /refusing: the tag .* already exists at/);
  assert.match(r.out, new RegExp(`sha256:${'42'.repeat(32)}`));
  assert.ok(readLog(w.bin).every((x) => x.sub === 'resolve'), 'a refused overwrite pushes nothing');
});

// ── (4) the token: never a child's environment, never `oras login`, and the
//        temp config is mode 600, token-carrying and removed on exit ───────────

test('token_reaches_oras_only_via_the_temp_registry_config', (t) => {
  const w = world();
  t.after(() => fs.rmSync(w.base, { recursive: true, force: true }));
  const r = publish(w);
  assert.equal(r.status, 0, r.out);
  const auth = Buffer.from(`${USER}:${TOKEN}`).toString('base64');
  const c = readLog(w.bin);
  assert.ok(c.length >= 3, 'the stub oras ran');
  for (const call of c) {
    assert.equal(call.tokenInEnv, false, `oras ${call.sub} got GHCR_TOKEN in its environment`);
    assert.ok(!JSON.stringify(call).includes(TOKEN), 'the token never appears in the logged argv');
    assert.ok(!call.argv.includes('login'), 'oras login is never called');
    assert.ok(call.configText.includes(auth), `${call.sub} used the token's registry config`);
    assert.equal(call.configMode, '600');
    assert.ok(fs.existsSync(call.config) === false, `${call.config} is removed after the run`);
  }
  // The dry run prints the sequence without ever naming the token.
  const dry = publish(w, ['--dry-run'], { GHCR_TOKEN: undefined, GHCR_USER: undefined });
  assert.equal(dry.status, 0, dry.out);
  assert.doesNotMatch(dry.out, new RegExp(TOKEN), 'dry-run output never prints the token');
  // Nothing is left behind in the run's temp dir.
  assert.deepEqual(fs.readdirSync(w.base).filter((f) => f.startsWith('publish-method-env-images.')), []);
});

// ── (5) the signing step: the release path WITHOUT --skip-sign, with stub
//        cosign on PATH — cosign must be called `sign --yes <ref>@<digest>`
//        with DOCKER_CONFIG pointing at a private dir whose config.json is the
//        token's ghcr.io config (and nothing else), with NO GHCR_TOKEN or
//        GHCR_USER in its environment; the user's own Docker config (HOME (a
//        temp dir)) is not created or changed; the private dir is gone after
//        the run. ───────────────────────────────────────────────────────────────

test('signing_step_uses_a_private_docker_config_for_cosign', (t) => {
  const w = world();
  fs.writeFileSync(path.join(w.bin, 'cosign'), COSIGN);
  fs.chmodSync(path.join(w.bin, 'cosign'), 0o755);
  // The user's own Docker config: HOME at a temp dir holding a sentinel
  // config.json — the run must neither create nor alter it.
  const home = tmp();
  fs.mkdirSync(path.join(home, '.docker'), { recursive: true });
  const ownConfig = Buffer.from(JSON.stringify({
    auths: { 'quay.io/example': { auth: Buffer.from('user:old').toString('base64') } },
  }, null, 2) + '\n');
  const ownConfigPath = path.join(home, '.docker', 'config.json');
  fs.writeFileSync(ownConfigPath, ownConfig);
  t.after(() => {
    fs.rmSync(w.base, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  // The real publisher, the real release path: no --registry (not loopback),
  // no --dry-run, and no --skip-sign.
  const r = publish(w, [], { HOME: home }, { skipSign: false });
  assert.equal(r.status, 0, r.out);

  // (1) the stub cosign ran exactly once, with `sign --yes <ref>@<digest>`.
  const logPath = path.join(w.bin, 'cosign.log');
  assert.ok(fs.existsSync(logPath), 'the stub cosign ran (cosign.log exists)');
  const calls = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.equal(calls.length, 1, 'cosign ran exactly once');
  const c = calls[0];
  assert.deepEqual(c.argv, ['sign', '--yes', `${LAYER_OCI}@${w.layerDigest}`]);

  // (2) DOCKER_CONFIG: a private dir whose config.json holds the ghcr.io auth
  //     entry for the test token — and nothing else — while cosign's
  //     environment carries no GHCR_TOKEN and no GHCR_USER.
  assert.ok(c.dockerConfig, 'DOCKER_CONFIG was set for cosign');
  assert.match(c.dockerConfig, /publish-method-env-images\.[^/]+\/cosign-docker$/);
  assert.ok(c.dockerConfig.startsWith(w.base), 'the private dir lives under the run temp dir');
  assert.ok(c.configJson, 'the private config.json exists');
  const auth = Buffer.from(`${USER}:${TOKEN}`).toString('base64');
  assert.deepEqual(JSON.parse(c.configJson), { auths: { 'ghcr.io': { auth } } });
  assert.equal(c.tokenInEnv, false, 'GHCR_TOKEN leaked into cosign\'s environment');
  assert.equal(c.userInEnv, false, 'GHCR_USER leaked into cosign\'s environment');

  // (3) the user's own Docker config was neither created nor changed.
  assert.ok(fs.existsSync(ownConfigPath), 'the user docker config still exists');
  assert.ok(fs.readFileSync(ownConfigPath).equals(ownConfig), 'the user docker config is unchanged');
  assert.deepEqual(fs.readdirSync(path.join(home, '.docker')), ['config.json']);

  // (4) the private dir (and the whole run temp dir) is gone after the run.
  assert.equal(fs.existsSync(c.dockerConfig), false, 'the private cosign dir is gone after the run');
  assert.deepEqual(fs.readdirSync(w.base).filter((f) => f.startsWith('publish-method-env-images.')), []);
});
