// stubs.mjs — stand-ins for `oras`, `minisign` and the `txresbench` binary, written into a
// test's own bin dir by scripts/publish-method-list.test.mjs and
// scripts/import-method-list.test.mjs. No network, no real key.
//
//   oras       a registry in <bin>/../registry (tags -> digests -> files); every call is
//              logged to <bin>/oras.log with its arguments, working dir, the content and
//              mode of its --registry-config file, and whether GHCR_TOKEN was in its
//              environment. <bin>/behavior.json changes what it does (see below).
//              An artifact's OCI manifest is stored beside its files (the shape the
//              publishers push), so `manifest fetch` serves it and `blob fetch
//              --descriptor` checks a blob's existence by its sha256 (the publisher's
//              step-d pin check).
//   minisign   -S writes a minisign-SHAPED signature (key id E7620F1842B4E81F, the sha256
//              of the file and of the trusted comment, no real ed25519); -V checks one
//              against the key id of -P. Its environment is logged to <bin>/minisign.log (it
//              runs under `env -i`, so it finds its log by its own path, not by a variable).
//   txresbench `check-method-list` over those signatures: the key id must be in the trusted
//              set (--keys, else <bin>/trusted-keys.json, the stand-in for the compiled-in
//              keys), then sha256 + comment + sequence. Logged to <bin>/cli.log.
//
// behavior.json (oras): resolveError: [tags] answer resolve with a non-"not found" error;
// corruptReadback: a pull by digest of a just-pushed artifact serves other list bytes;
// moveV1OnPush: 'verified' | 'unverified' moves v2 to a list #99 during the push;
// corruptV1AfterTag; privateUntilPublic.
//
// The real minisign and the real verifier are covered by the Rust unit tests over the
// fixtures signed with the real minisign (scripts/method-list/fixtures/).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** The key the stub minisign signs with (minisign's documentation key: a valid key shape). */
export const STUB_KEY = {
  label: 'stub maintainer',
  key_id: 'E7620F1842B4E81F',
  public_key: 'RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3',
};

// The OCI artifact types the env-image publishers pin (scripts/generate-method-env-images.py).
const LAYER_ARTIFACT_TYPE = 'application/vnd.txr.method-env.layer.v1';
const BASE_ARTIFACT_TYPE = 'application/vnd.txr.method-env.base.v1';

const COMMON = String.raw`
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const BIN = path.dirname(new URL(import.meta.url).pathname);
const sha = (b) => crypto.createHash('sha256').update(b).digest();
const KEY_ID_LE = Buffer.from('E7620F1842B4E81F', 'hex').reverse();
function makeSig(bytes, trusted, untrusted, keyIdLe = KEY_ID_LE) {
  const line2 = Buffer.concat([Buffer.from('ED'), keyIdLe, sha(bytes), Buffer.alloc(32)]).toString('base64');
  const line4 = Buffer.concat([sha(Buffer.from(trusted)), Buffer.alloc(32)]).toString('base64');
  return 'untrusted comment: ' + untrusted + '\n' + line2 + '\ntrusted comment: ' + trusted + '\n' + line4 + '\n';
}
// trustedIds: little-endian key id buffers (the bytes inside a key and a signature).
function checkSig(bytes, sigText, trustedIds = [KEY_ID_LE]) {
  const lines = sigText.split('\n');
  if (lines.length < 4) return 'not a signature';
  const raw = Buffer.from(lines[1], 'base64');
  if (raw.length !== 74 || raw.subarray(0, 2).toString() !== 'ED') return 'not a prehashed signature';
  if (!trustedIds.some((id) => raw.subarray(2, 10).equals(id))) return 'METHOD_LIST_UNKNOWN_KEY';
  if (!raw.subarray(10, 42).equals(sha(bytes))) return 'METHOD_LIST_BAD_SIGNATURE';
  const comment = lines[2].replace(/^trusted comment: /, '');
  if (!Buffer.from(lines[3], 'base64').subarray(0, 32).equals(sha(Buffer.from(comment)))) return 'METHOD_LIST_BAD_SIGNATURE';
  return { comment };
}
`;

const ORAS = String.raw`#!/usr/bin/env node
${COMMON}
const REG = path.join(BIN, '..', 'registry');
const behavior = fs.existsSync(path.join(BIN, 'behavior.json')) ? JSON.parse(fs.readFileSync(path.join(BIN, 'behavior.json'), 'utf8')) : {};
const argv = process.argv.slice(2);
const sub = argv[0];
const pos = []; const ann = []; let config = null; let plain = false; let out = null; let type = null; let descriptor = false;
let firstPos = -1;
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--registry-config') config = argv[++i];
  else if (a === '--plain-http') plain = true;
  else if (a === '--annotation') ann.push(argv[++i]);
  else if (a === '--artifact-type') type = argv[++i];
  else if (a === '--descriptor') descriptor = true;
  else if (a === '-o') out = argv[++i];
  else { if (firstPos < 0) firstPos = i; pos.push(a); }
}
let configText = null; let configMode = null;
if (config && fs.existsSync(config)) { configText = fs.readFileSync(config, 'utf8'); configMode = (fs.statSync(config).mode & 0o777).toString(8); }
fs.appendFileSync(path.join(BIN, 'oras.log'), JSON.stringify({ sub, argv, cwd: process.cwd(), config, configText, configMode, plain, tokenInEnv: 'GHCR_TOKEN' in process.env }) + '\n');
const split = (ref) => {
  const at = ref.indexOf('@');
  if (at >= 0) return { repo: ref.slice(0, at), digest: ref.slice(at + 1) };
  const slash = ref.lastIndexOf('/'); const colon = ref.lastIndexOf(':');
  if (colon > slash) return { repo: ref.slice(0, colon), tag: ref.slice(colon + 1) };
  return { repo: ref, tag: 'latest' };
};
const repoDir = (repo) => path.join(REG, repo.replace(/[/:]/g, '_'));
const tagFile = (repo, tag) => path.join(repoDir(repo), 'tags', tag);
const resolve = (ref) => {
  const r = split(ref);
  if (r.digest) return fs.existsSync(path.join(repoDir(r.repo), 'blobs', r.digest.replace(':', '_'))) ? r.digest : null;
  return fs.existsSync(tagFile(r.repo, r.tag)) ? fs.readFileSync(tagFile(r.repo, r.tag), 'utf8').trim() : null;
};
const fail = (m) => { process.stderr.write('Error: ' + m + '\n'); process.exit(1); };
// "manifest"/"blob" take a SUB-subcommand ("fetch"): real oras (cobra) can swallow it as the
// value of a flag it does not know on the parent command, so the publisher must put the
// sub-subcommand FIRST. Refuse the bad order (a flag before "fetch") here so a publisher
// regression is caught by the test instead of silently accepted.
if ((sub === 'manifest' || sub === 'blob') && firstPos > 1 && (pos[0] === 'fetch' || pos[0] === 'push')) {
  fail('stub oras: ' + sub + ' ' + pos[0] + ' must come before any flag (a flag before "' + pos[0] + '" can swallow it)');
}
const tagged = () => fs.existsSync(path.join(BIN, 'oras.log')) && fs.readFileSync(path.join(BIN, 'oras.log'), 'utf8').split('\n').some((l) => l.includes('"sub":"tag"'));
// privateUntilPublic: the method list package answers anonymous reads with nothing.
const anonymous = !configText || configText === '{}';
if (behavior.privateUntilPublic && anonymous && (sub === 'resolve' || sub === 'pull') && pos[0].includes('txresbench-method-list')) {
  fail('unauthorized: authentication required');
}
const pushedFile = path.join(BIN, 'pushed.txt');
const pushed = () => fs.existsSync(pushedFile) ? fs.readFileSync(pushedFile, 'utf8').split('\n').filter(Boolean) : [];
// The OCI artifact-manifest shape the real publishers push (generate-method-env-images.py
// pins it): one layer per file, titled with the file name (the name oras pull extracts),
// the OCI empty JSON as the config. The manifest digests are the real sha256 of the stored
// bytes, so the manifest-fetch and blob-fetch subcommands model a registry that verifies
// blobs against their digest on upload.
const OCI_MANIFEST_MEDIA = 'application/vnd.oci.image.manifest.v1+json';
const LAYER_MEDIA = 'application/vnd.txr.method-env.layer.v1';
const BASE_MEDIA = 'application/vnd.txr.method-env.base.v1';
const OCI_EMPTY_CONFIG = {
  mediaType: 'application/vnd.oci.empty.v1+json',
  digest: 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
  size: 2,
};
const mediaForFile = (name) => name === 'base.squashfs' ? BASE_MEDIA : name.endsWith('.squashfs') ? LAYER_MEDIA : 'application/octet-stream';
const ociManifest = (artifactType, layers, annotations = {}) => ({
  schemaVersion: 2, mediaType: OCI_MANIFEST_MEDIA, artifactType,
  config: OCI_EMPTY_CONFIG, layers, annotations,
});
// The OCI manifest of one artifact holding files (name, bytes, media), digesting every
// file from its stored bytes (a registry verifies a blob against its digest on upload).
const writeOciManifest = (dir, artifactType, files, annotations = {}) =>
  fs.writeFileSync(path.join(dir, 'manifest.json'),
    JSON.stringify(ociManifest(artifactType, files.map((f) => ({
      mediaType: f.media || mediaForFile(f.name),
      digest: 'sha256:' + sha(f.bytes).toString('hex'),
      size: f.bytes.length,
      annotations: { 'org.opencontainers.image.title': f.name },
    })), annotations)));
if (sub === 'resolve') {
  if ((behavior.resolveError || []).includes(split(pos[0]).tag)) fail('GET ' + pos[0] + ': unexpected status code 500');
  const d = resolve(pos[0]); if (!d) fail('not found: ' + pos[0]); process.stdout.write(d + '\n');
} else if (sub === 'repo' && pos[0] === 'tags') {
  const dir = path.join(repoDir(pos[1]), 'tags');
  if (!fs.existsSync(dir)) fail('not found: ' + pos[1]);
  process.stdout.write(fs.readdirSync(dir).sort().join('\n') + '\n');
} else if (sub === 'pull') {
  const d = resolve(pos[0]); if (!d) fail('not found: ' + pos[0]);
  const dir = path.join(repoDir(split(pos[0]).repo), 'blobs', d.replace(':', '_'), 'files');
  fs.mkdirSync(out, { recursive: true });
  for (const f of fs.readdirSync(dir)) {
    let bytes = fs.readFileSync(path.join(dir, f));
    if (behavior.corruptV1AfterTag && split(pos[0]).tag === 'v2' && tagged() && f === 'method-list.json') bytes = Buffer.concat([bytes, Buffer.from(' ')]);
    if (behavior.corruptReadback && split(pos[0]).digest && pushed().includes(d) && f === 'method-list.json') bytes = Buffer.concat([bytes, Buffer.from(' ')]);
    fs.writeFileSync(path.join(out, f), bytes);
  }
} else if (sub === 'push') {
  const r = split(pos[0]);
  const files = pos.slice(1).map((s) => { const i = s.lastIndexOf(':'); return { name: s.slice(0, i), media: s.slice(i + 1) }; });
  const desc = files.map((f) => ({ ...f, sha256: sha(fs.readFileSync(path.join(process.cwd(), f.name))).toString('hex') }));
  const digest = 'sha256:' + sha(Buffer.from(JSON.stringify({ type, ann, desc }))).toString('hex');
  const dir = path.join(repoDir(r.repo), 'blobs', digest.replace(':', '_'));
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
  for (const f of files) fs.copyFileSync(path.join(process.cwd(), f.name), path.join(dir, 'files', f.name));
  writeOciManifest(dir, type,
    files.map((f) => ({ name: f.name, bytes: fs.readFileSync(path.join(process.cwd(), f.name)), media: f.media })),
    Object.fromEntries(ann.map((a) => { const i = a.indexOf('='); return [a.slice(0, i), a.slice(i + 1)]; })));
  fs.mkdirSync(path.dirname(tagFile(r.repo, r.tag)), { recursive: true });
  fs.writeFileSync(tagFile(r.repo, r.tag), digest);
  fs.appendFileSync(pushedFile, digest + '\n');
  if (behavior.moveV1OnPush) {
    // Another maintainer's list #99 lands on v1 meanwhile: signed by the trusted stub key, or
    // by a key nobody trusts.
    const other = path.join(repoDir(r.repo), 'blobs', 'sha256_' + 'e'.repeat(64));
    fs.mkdirSync(path.join(other, 'files'), { recursive: true });
    const list = Buffer.from(JSON.stringify({ format_version: 2, sequence: 99 }));
    const keyId = behavior.moveV1OnPush === 'verified' ? KEY_ID_LE : Buffer.alloc(8, 7);
    fs.writeFileSync(path.join(other, 'files', 'method-list.json'), list);
    fs.writeFileSync(path.join(other, 'files', 'method-list.json.minisig'),
      makeSig(list, 'txresbench-method-list format=2 sequence=99', 'other', keyId));
    fs.writeFileSync(tagFile(r.repo, 'v2'), 'sha256:' + 'e'.repeat(64));
  }
  process.stdout.write('Pushed ' + pos[0] + '\nDigest: ' + digest + '\n');
} else if (sub === 'tag') {
  const d = resolve(pos[0]); if (!d) fail('not found: ' + pos[0]);
  const r = split(pos[0]);
  for (const t of pos.slice(1)) { fs.mkdirSync(path.dirname(tagFile(r.repo, t)), { recursive: true }); fs.writeFileSync(tagFile(r.repo, t), d); }
} else if (sub === 'manifest' && pos[0] === 'fetch') {
  const ref = pos[1];
  const d = resolve(ref); if (!d) fail('not found: ' + ref);
  const manifest = path.join(repoDir(split(ref).repo), 'blobs', d.replace(':', '_'), 'manifest.json');
  if (!fs.existsSync(manifest)) fail('not found: ' + ref);
  process.stdout.write(fs.readFileSync(manifest, 'utf8'));
} else if (sub === 'blob' && pos[0] === 'fetch') {
  const ref = pos[1];
  const r = split(ref);
  if (!r.digest) fail('invalid reference: ' + ref);
  const hex = r.digest.replace(/^sha256:/, '');
  let found = null;
  const blobs = path.join(repoDir(r.repo), 'blobs');
  if (fs.existsSync(blobs)) {
    for (const blob of fs.readdirSync(blobs)) {
      const files = path.join(blobs, blob, 'files');
      if (!fs.existsSync(files)) continue;
      for (const f of fs.readdirSync(files)) {
        const bytes = fs.readFileSync(path.join(files, f));
        if (sha(bytes).toString('hex') === hex) { found = { name: f, bytes }; break; }
      }
      if (found) break;
    }
  }
  if (!found) fail('not found: ' + ref);
  if (descriptor) {
    process.stdout.write(JSON.stringify({ mediaType: 'application/octet-stream', digest: 'sha256:' + hex, size: found.bytes.length }) + '\n');
  } else {
    fail('stub oras: blob fetch needs --descriptor (the existence check)');
  }
} else {
  fail('stub oras: unsupported ' + sub);
}
`;

const MINISIGN = String.raw`#!/usr/bin/env node
${COMMON}
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(BIN, 'minisign.log'), JSON.stringify({ argv, envKeys: Object.keys(process.env).sort() }) + '\n');
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
if (argv.includes('-S')) {
  const file = opt('-m');
  fs.writeFileSync(opt('-x') || file + '.minisig', makeSig(fs.readFileSync(file), opt('-t'), opt('-c') || 'signature'));
} else if (argv.includes('-V')) {
  const file = opt('-m');
  const pk = Buffer.from(opt('-P') || '', 'base64');
  const r = checkSig(fs.readFileSync(file), fs.readFileSync(opt('-x') || file + '.minisig', 'utf8'), [pk.subarray(2, 10)]);
  if (typeof r === 'string') { process.stderr.write('Signature verification failed: ' + r + '\n'); process.exit(1); }
} else { process.exit(2); }
`;

const CLI = String.raw`#!/usr/bin/env node
${COMMON}
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(BIN, 'cli.log'), JSON.stringify({ argv, tokenInEnv: 'GHCR_TOKEN' in process.env }) + '\n');
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
if (argv[0] !== 'check-method-list') process.exit(2);
const bytes = fs.readFileSync(opt('--list'));
let doc;
try { doc = JSON.parse(bytes); } catch { process.stderr.write('check-method-list: METHOD_LIST_HEADER_INVALID\n'); process.exit(1); }
// The trusted set: --keys, else the stand-in for the compiled-in keys.
const keysFile = opt('--keys') || path.join(BIN, 'trusted-keys.json');
const trusted = fs.existsSync(keysFile)
  ? JSON.parse(fs.readFileSync(keysFile, 'utf8')).keys.map((k) => Buffer.from(k.public_key, 'base64').subarray(2, 10))
  : [];
if (opt('--signature')) {
  const r = checkSig(bytes, fs.readFileSync(opt('--signature'), 'utf8'), trusted);
  if (typeof r === 'string') { process.stderr.write('check-method-list: ' + r + '\n'); process.exit(1); }
  if (r.comment !== 'txresbench-method-list format=' + doc.format_version + ' sequence=' + doc.sequence) { process.stderr.write('check-method-list: METHOD_LIST_COMMENT_MISMATCH\n'); process.exit(1); }
} else if (doc.sequence !== 0) { process.stderr.write('check-method-list: METHOD_LIST_UNSIGNED\n'); process.exit(1); }
process.stdout.write('method list OK\nformat: txresbench-method-list ' + doc.format_version + '\nsequence: ' + doc.sequence + '\n');
`;

// A `txresbench check-method-list` that verifies REAL minisign signatures (prehashed
// Ed25519 over BLAKE2b-512, then the global signature over signature + trusted comment)
// with node:crypto, against the trusted-keys file given with --keys. The import controls
// use it with the fixtures signed by the real minisign; set TXR_CLI to run them against the
// real binary instead.
const VERIFYING_CLI = String.raw`#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
const argv = process.argv.slice(2);
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const die = (m) => { process.stderr.write('check-method-list: ' + m + '\n'); process.exit(1); };
if (argv[0] !== 'check-method-list') process.exit(2);
const bytes = fs.readFileSync(opt('--list'));
let doc = null;
const sigPath = opt('--signature');
if (sigPath) {
  const lines = fs.readFileSync(sigPath, 'utf8').split('\n');
  const raw = Buffer.from(lines[1] || '', 'base64');
  if (raw.length !== 74) die('METHOD_LIST_SIGNATURE_UNREADABLE');
  if (raw.subarray(0, 2).toString() === 'Ed') die('METHOD_LIST_LEGACY_SIGNATURE');
  const keys = JSON.parse(fs.readFileSync(opt('--keys'), 'utf8')).keys;
  const key = keys.map((k) => Buffer.from(k.public_key, 'base64')).find((k) => k.subarray(2, 10).equals(raw.subarray(2, 10)));
  if (!key) die('METHOD_LIST_UNKNOWN_KEY');
  const pub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.subarray(10).toString('base64url') }, format: 'jwk' });
  const hash = crypto.createHash('blake2b512').update(bytes).digest();
  if (!crypto.verify(null, hash, pub, raw.subarray(10))) die('METHOD_LIST_BAD_SIGNATURE');
  const comment = (lines[2] || '').replace(/^trusted comment: /, '');
  const global = Buffer.from(lines[3] || '', 'base64');
  if (!crypto.verify(null, Buffer.concat([raw.subarray(10), Buffer.from(comment)]), pub, global)) die('METHOD_LIST_BAD_SIGNATURE');
  const m = /^txresbench-method-list format=(\d+) sequence=(\d+)$/.exec(comment);
  if (!m) die('METHOD_LIST_WRONG_PURPOSE');
  try { doc = JSON.parse(bytes); } catch { die('METHOD_LIST_HEADER_INVALID'); }
  if (Number(m[1]) !== doc.format_version || Number(m[2]) !== doc.sequence) die('METHOD_LIST_COMMENT_MISMATCH');
} else {
  try { doc = JSON.parse(bytes); } catch { die('METHOD_LIST_HEADER_INVALID'); }
  if (doc.sequence !== 0) die('METHOD_LIST_UNSIGNED');
}
process.stdout.write('method list OK\nformat: txresbench-method-list ' + doc.format_version + '\nsequence: ' + doc.sequence + '\n');
`;

/** Write the verifying `txresbench` stand-in into `bin`; returns its path. */
export function writeVerifyingCli(bin) {
  fs.mkdirSync(bin, { recursive: true });
  const p = path.join(bin, 'txresbench-verify');
  fs.writeFileSync(p, VERIFYING_CLI);
  fs.chmodSync(p, 0o755);
  return p;
}

/** A `cargo` that logs its working dir and arguments to <bin>/cargo.log and runs `cli` with
 * the arguments after `--` (the scripts' default verifier is `cargo run … -- <args>`). */
export function writeCargoStub(bin, cli) {
  fs.mkdirSync(bin, { recursive: true });
  const p = path.join(bin, 'cargo');
  fs.writeFileSync(p, `#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(bin, 'cargo.log'))}, JSON.stringify({ cwd: process.cwd(), argv, tokenInEnv: 'GHCR_TOKEN' in process.env }) + '\\n');
const r = spawnSync(${JSON.stringify(cli)}, argv.slice(argv.indexOf('--') + 1), { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
`);
  fs.chmodSync(p, 0o755);
  return p;
}

/** Write the three stubs into `bin` (a fresh dir); returns their paths. */
export function writeStubs(bin) {
  fs.mkdirSync(bin, { recursive: true });
  const out = {};
  for (const [name, text] of [['oras', ORAS], ['minisign', MINISIGN], ['txresbench', CLI]]) {
    const p = path.join(bin, name);
    fs.writeFileSync(p, text);
    fs.chmodSync(p, 0o755);
    out[name] = p;
  }
  return out;
}

/** A stub signature (the stub minisign's format) of `bytes` with the trusted `comment`, by
 * the key with id `keyIdHex` (as minisign prints it). */
export function stubSignature(bytes, comment, keyIdHex = STUB_KEY.key_id) {
  const sha = (b) => crypto.createHash('sha256').update(b).digest();
  const keyId = Buffer.from(keyIdHex, 'hex').reverse();
  const line2 = Buffer.concat([Buffer.from('ED'), keyId, sha(bytes), Buffer.alloc(32)]).toString('base64');
  const line4 = Buffer.concat([sha(Buffer.from(comment)), Buffer.alloc(32)]).toString('base64');
  return `untrusted comment: stub\n${line2}\ntrusted comment: ${comment}\n${line4}\n`;
}

/** Put an artifact holding `files` ({name: Buffer}) at `<ref>:<tag>` in the stub registry.
 * The OCI artifact manifest is written alongside (the shape the publishers push; the
 * digest of each layer is the sha256 of the stored bytes), so `oras manifest fetch`
 * answers for it like a real registry. `artifactType`/`annotations` are optional; the
 * artifact type is derived from the file names when not given. */
export function seedArtifact(bin, repo, tag, files, digest, { artifactType = null, annotations = {} } = {}) {
  const dir = path.join(bin, '..', 'registry', repo.replace(/[/:]/g, '_'));
  const blob = path.join(dir, 'blobs', digest.replace(':', '_'), 'files');
  fs.mkdirSync(blob, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(blob, name), bytes);
  const names = Object.keys(files);
  const type = artifactType || (names.includes('base.squashfs') ? BASE_ARTIFACT_TYPE
    : names.some((n) => n.endsWith('.squashfs')) ? LAYER_ARTIFACT_TYPE
    : 'application/vnd.txresbench.method-list.v1');
  fs.writeFileSync(path.join(dir, 'blobs', digest.replace(':', '_'), 'manifest.json'),
    JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      artifactType: type,
      config: {
        mediaType: 'application/vnd.oci.empty.v1+json',
        digest: 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
        size: 2,
      },
      layers: Object.entries(files).map(([name, bytes]) => ({
        mediaType: name === 'base.squashfs' ? BASE_ARTIFACT_TYPE
          : name.endsWith('.squashfs') ? LAYER_ARTIFACT_TYPE : 'application/octet-stream',
        digest: 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
        annotations: { 'org.opencontainers.image.title': name },
      })),
      annotations,
    }));
  fs.mkdirSync(path.join(dir, 'tags'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tags', tag), digest);
}

/** The JSON lines of a stub log (empty when the stub never ran). */
export function readLog(bin, name) {
  const p = path.join(bin, `${name}.log`);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
