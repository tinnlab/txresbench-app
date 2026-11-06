#!/usr/bin/env node
// scripts/installer/bundle-pretrained-models.test.mjs — TEST-IR-5/7/8 (PROV-IR-4).
//
// The negative controls for `scripts/installer/bundle-pretrained-models.mjs`.
// Every assertion DRIVES the real script as a subprocess and reads its OWN exit
// status, never a status observed through a pipe. The loopback server records
// every request line so "the fetch happened" / "nothing was fetched" is a
// measured claim, not an inference; `--base-url` keeps all server traffic on
// loopback (the test seam PROV-IR-4 names), so no control touches the network.
//
// The subprocess is awaited with async `spawn` — deliberately NOT `spawnSync`:
// the loopback server lives in this process, and a synchronous wait would block
// the parent's event loop while the child waits for the server, deadlocking in
// both directions.
//
//   node --test scripts/installer/bundle-pretrained-models.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SCRIPTS_DIR, '..', '..');
const SCRIPT = path.join(SCRIPTS_DIR, 'bundle-pretrained-models.mjs');
const FIXTURE_MANIFEST = path.join(REPO, 'scripts/installer/fixtures/bundled-models.json');
const FIXTURE_ASSETS = path.join(REPO, 'scripts/installer/fixtures/assets');

const TMPDIRS = [];
process.on('exit', () => {
  for (const d of TMPDIRS) fs.rmSync(d, { recursive: true, force: true });
});

function scratch(prefix) {
  const base = process.env.TMPDIR || os.tmpdir();
  const dir = fs.mkdtempSync(path.join(base, prefix));
  TMPDIRS.push(dir);
  return dir;
}

/** Run the real script as a subprocess; resolves with its own status + output. */
function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ status: code ?? -1, out }));
    child.on('error', (err) => resolve({ status: -1, out: String(err) }));
  });
}

/** The fixture manifest, rewritten for a test (`models` is the array). */
function write_manifest(dir, models, extra = {}) {
  const doc = { schema_version: 1, ...extra, models };
  const file = path.join(dir, 'bundled-models.json');
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 1)}\n`, 'utf8');
  return file;
}

/** A one-entry manifest (relchange-threshold), like the acceptance example. */
function one_entry_manifest(dir, overrides = {}) {
  const doc = JSON.parse(fs.readFileSync(FIXTURE_MANIFEST, 'utf8'));
  const entry = { ...doc.models[0], ...overrides };
  return write_manifest(dir, [entry]);
}

/**
 * A loopback HTTP server with recorded request lines.
 *
 * `routes` maps the request PATH (no query) to `{ body }`, `{ status, body }`
 * or `{ redirect }` (302 to a location string).
 */
async function start_server(routes) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    const route = routes[req.url.split('?')[0]];
    if (!route) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    if (route.redirect !== undefined) {
      res.writeHead(302, { location: route.redirect });
      res.end();
      return;
    }
    res.writeHead(route.status ?? 200, { 'content-type': 'application/octet-stream' });
    res.end(route.body ?? '');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port,
    requests,
    close: () => new Promise((resolve) => server.closeAllConnections?.() ?? server.close(resolve)),
  };
}

/** The real fixture bytes of every entry, keyed by manifest url path. */
function fixture_routes() {
  const doc = JSON.parse(fs.readFileSync(FIXTURE_MANIFEST, 'utf8'));
  const routes = {};
  for (const entry of doc.models) {
    const url = new URL(entry.url);
    routes[url.pathname] = { body: fs.readFileSync(path.join(FIXTURE_ASSETS, entry.file)) };
  }
  return routes;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ── TEST-IR-5 / verify-before-write ─────────────────────────────────────────────
test('TEST-IR-5 the staged bytes are verified against the manifest before writing; a tampered body aborts naming the entry', async () => {
  const dir = scratch('txr-bundle-');
  const manifest = one_entry_manifest(dir);
  const out = path.join(dir, 'out');
  const doc = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const url = new URL(doc.models[0].url);
  const good = fs.readFileSync(path.join(FIXTURE_ASSETS, doc.models[0].file));
  const tampered = Buffer.concat([good.subarray(0, 8), Buffer.from('flipped!'), good.subarray(16)]);

  const server = await start_server({ [url.pathname]: { body: tampered } });
  try {
    const r = await run(['--manifest', manifest, '--out', out, '--base-url', `http://127.0.0.1:${server.port}`]);
    assert.equal(r.status, 1, `expected exit 1:\n${r.out}`);
    assert.match(r.out, /sha256 .*!= manifest/);
    assert.match(r.out, /relchange-threshold/);
    // Nothing of the failing run survives: no staged file, no manifest copy.
    assert.ok(!fs.existsSync(path.join(out, doc.models[0].file)), 'tampered body must not be staged');
    assert.ok(!fs.existsSync(path.join(out, 'bundled-models.json')), 'no manifest copy after a failed run');
    assert.deepEqual(server.requests.map((q) => q.url), [url.pathname]);
  } finally {
    await server.close();
  }
});

test('TEST-IR-5 a wrong-size body aborts naming the entry and the two numbers', async () => {
  const dir = scratch('txr-bundle-');
  const manifest = one_entry_manifest(dir);
  const out = path.join(dir, 'out');
  const doc = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const url = new URL(doc.models[0].url);
  const good = fs.readFileSync(path.join(FIXTURE_ASSETS, doc.models[0].file));
  const short = good.subarray(0, good.length - 10);

  const server = await start_server({ [url.pathname]: { body: short } });
  try {
    const r = await run(['--manifest', manifest, '--out', out, '--base-url', `http://127.0.0.1:${server.port}`]);
    assert.equal(r.status, 1, `expected exit 1:\n${r.out}`);
    assert.match(r.out, /fetched \d+ bytes, manifest size_bytes/);
    assert.match(r.out, /relchange-threshold/);
    assert.ok(!fs.existsSync(path.join(out, doc.models[0].file)));
  } finally {
    await server.close();
  }
});

test('TEST-IR-5 a multi-entry run is per-entry atomic: the failing entry is never staged, the manifest copy waits for all entries', async () => {
  const dir = scratch('txr-bundle-');
  const manifest = FIXTURE_MANIFEST; // two entries, relchange first
  const out = path.join(dir, 'out');
  const doc = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const bad = doc.models[1];
  const badUrl = new URL(bad.url);
  const routes = fixture_routes();
  routes[badUrl.pathname] = { body: Buffer.from('totally different bytes') };

  const server = await start_server(routes);
  try {
    const r = await run(['--manifest', manifest, '--out', out, '--base-url', `http://127.0.0.1:${server.port}`]);
    assert.equal(r.status, 1, `expected exit 1:\n${r.out}`);
    assert.match(r.out, /squeeze-fit/);
    // The verified entry is staged (per-entry atomic + rerun-idempotent) but
    // the manifest copy is not, so the incomplete set is never advertised.
    assert.ok(fs.existsSync(path.join(out, doc.models[0].file)));
    assert.ok(!fs.existsSync(path.join(out, bad.file)));
    assert.ok(!fs.existsSync(path.join(out, 'bundled-models.json')));
  } finally {
    await server.close();
  }
});

// ── TEST-IR-7 / parity ───────────────────────────────────────────────────────────
test('TEST-IR-7 every bundled entry maps to exactly one verified staged file, and the manifest is copied byte-identical', async () => {
  const dir = scratch('txr-bundle-');
  const manifest = FIXTURE_MANIFEST;
  const out = path.join(dir, 'out');
  const server = await start_server(fixture_routes());
  try {
    const r = await run(['--manifest', manifest, '--out', out, '--base-url', `http://127.0.0.1:${server.port}`]);
    assert.equal(r.status, 0, `expected exit 0:\n${r.out}`);
    const doc = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    const staged = fs.readdirSync(out).filter((n) => n.endsWith('.txr')).sort();
    assert.deepEqual(staged, doc.models.map((e) => e.file).sort());
    for (const entry of doc.models) {
      const bytes = fs.readFileSync(path.join(out, entry.file));
      assert.equal(sha256(bytes), entry.sha256);
      assert.equal(bytes.length, entry.size_bytes);
    }
    assert.ok(fs.readFileSync(path.join(out, 'bundled-models.json')).equals(fs.readFileSync(manifest)));

    const check = await run(['--manifest', manifest, '--out', out, '--check']);
    assert.equal(check.status, 0, `--check of the staged set must pass:\n${check.out}`);

    // A missing staged file fails --check naming the entry.
    fs.rmSync(path.join(out, doc.models[0].file));
    const missing = await run(['--manifest', manifest, '--out', out, '--check']);
    assert.equal(missing.status, 1);
    assert.match(missing.out, /staged file missing for entry relchange-threshold/);

    // Restore, then an EXTRA staged file fails --check: the set is exactly the
    // manifest's.
    fs.copyFileSync(path.join(FIXTURE_ASSETS, doc.models[0].file), path.join(out, doc.models[0].file));
    fs.copyFileSync(path.join(FIXTURE_ASSETS, doc.models[0].file), path.join(out, 'rogue@9.9.9.txr'));
    const extra = await run(['--manifest', manifest, '--out', out, '--check']);
    assert.equal(extra.status, 1);
    assert.match(extra.out, /unexpected staged file: rogue@9\.9\.9\.txr/);

    // A corrupted staged file fails --check (the re-verify at parity time).
    fs.rmSync(path.join(out, 'rogue@9.9.9.txr'));
    fs.writeFileSync(path.join(out, doc.models[1].file), 'corrupted bytes');
    const corrupt = await run(['--manifest', manifest, '--out', out, '--check']);
    assert.equal(corrupt.status, 1);
    assert.match(corrupt.out, /does not match the manifest/);

    // A manifest copy that is not byte-identical fails --check.
    fs.writeFileSync(path.join(out, 'bundled-models.json'), '{ "models": [] }\n');
    const copy = await run(['--manifest', manifest, '--out', out, '--check']);
    assert.equal(copy.status, 1);
    assert.match(copy.out, /not byte-identical/);
  } finally {
    await server.close();
  }
});

test('TEST-IR-7 an absent manifest exits 0 and stages nothing (no bundled models yet — valid state)', async () => {
  const dir = scratch('txr-bundle-');
  const out = path.join(dir, 'out');
  const r = await run(['--manifest', path.join(dir, 'no-such-manifest.json'), '--out', out]);
  assert.equal(r.status, 0, `expected exit 0:\n${r.out}`);
  assert.match(r.out, /no bundled models yet/);
  assert.ok(!fs.existsSync(out), 'an absent manifest must not create the staging dir');
});

test('an empty bundled set stages the manifest only (one source of truth, zero models)', async () => {
  const dir = scratch('txr-bundle-');
  const manifest = write_manifest(dir, []);
  const out = path.join(dir, 'out');
  const r = await run(['--manifest', manifest, '--out', out]);
  assert.equal(r.status, 0, `expected exit 0:\n${r.out}`);
  assert.ok(fs.readFileSync(path.join(out, 'bundled-models.json')).equals(fs.readFileSync(manifest)));
  assert.equal(fs.readdirSync(out).filter((n) => n.endsWith('.txr')).length, 0);
});

// ── TEST-IR-8 / host policy, dry-run, base-url ──────────────────────────────────
test('TEST-IR-8 a manifest url on a host outside {github.com, tinnlab.github.io} exits 1 naming the host, with no fetch', async () => {
  const dir = scratch('txr-bundle-');
  const manifest = one_entry_manifest(dir, { url: 'https://evil.invalid/releases/download/models-v0.4.0/relchange-threshold@0.4.0.txr' });
  const out = path.join(dir, 'out');
  const server = await start_server({});
  try {
    const r = await run([
      '--manifest', manifest, '--out', out,
      '--base-url', `http://127.0.0.1:${server.port}`,
    ]);
    assert.equal(r.status, 1, `expected exit 1:\n${r.out}`);
    assert.match(r.out, /url host evil\.invalid is outside \{github\.com, tinnlab\.github\.io\}/);
    assert.equal(server.requests.length, 0, 'the bad-host check must precede any fetch');
    assert.ok(!fs.existsSync(out));
  } finally {
    await server.close();
  }
});

test('TEST-IR-8 --dry-run prints the plan and fetches nothing', async () => {
  const dir = scratch('txr-bundle-');
  const manifest = FIXTURE_MANIFEST;
  const out = path.join(dir, 'out');
  const server = await start_server(fixture_routes());
  try {
    const r = await run(['--manifest', manifest, '--out', out, '--dry-run', '--base-url', `http://127.0.0.1:${server.port}`]);
    assert.equal(r.status, 0, `expected exit 0:\n${r.out}`);
    assert.match(r.out, /would stage 2 bundled model\(s\)/);
    assert.match(r.out, /relchange-threshold@0\.4\.0/);
    assert.match(r.out, /copy bundled-models\.json/);
    assert.equal(server.requests.length, 0, '--dry-run must not fetch');
    assert.ok(!fs.existsSync(out), '--dry-run must not write');
  } finally {
    await server.close();
  }
});

test('TEST-IR-8 --base-url lets a loopback server serve the bytes (the test seam)', async () => {
  const dir = scratch('txr-bundle-');
  const manifest = one_entry_manifest(dir);
  const out = path.join(dir, 'out');
  const doc = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const url = new URL(doc.models[0].url);
  const server = await start_server({ [url.pathname]: { body: fs.readFileSync(path.join(FIXTURE_ASSETS, doc.models[0].file)) } });
  try {
    const r = await run(['--manifest', manifest, '--out', out, '--base-url', `http://127.0.0.1:${server.port}`]);
    assert.equal(r.status, 0, `expected exit 0:\n${r.out}`);
    assert.deepEqual(server.requests.map((q) => `${q.method} ${q.url}`), [`GET ${url.pathname}`]);
    assert.equal(sha256(fs.readFileSync(path.join(out, doc.models[0].file))), doc.models[0].sha256);
  } finally {
    await server.close();
  }
});

test('a non-loopback --base-url is refused (the seam is loopback-only)', async () => {
  const dir = scratch('txr-bundle-');
  const out = path.join(dir, 'out');
  const r = await run(['--manifest', FIXTURE_MANIFEST, '--out', out, '--base-url', 'http://models.example.com/']);
  assert.equal(r.status, 2);
  assert.match(r.out, /must be a loopback host/);
  const both = await run(['--manifest', FIXTURE_MANIFEST, '--out', out, '--dry-run', '--check']);
  assert.equal(both.status, 2);
  assert.match(both.out, /exclusive/);
});

// ── idempotency + redirects ─────────────────────────────────────────────────────
test('a second run fetches nothing and rewrites nothing (idempotent staging)', async () => {
  const dir = scratch('txr-bundle-');
  const manifest = FIXTURE_MANIFEST;
  const out = path.join(dir, 'out');
  const server = await start_server(fixture_routes());
  try {
    const first = await run(['--manifest', manifest, '--out', out, '--base-url', `http://127.0.0.1:${server.port}`]);
    assert.equal(first.status, 0, first.out);
    const mtimes = fs.readdirSync(out).map((n) => [n, fs.statSync(path.join(out, n)).mtimeMs]);
    const requestsAfterFirst = server.requests.length;

    const second = await run(['--manifest', manifest, '--out', out, '--base-url', `http://127.0.0.1:${server.port}`]);
    assert.equal(second.status, 0, `expected exit 0:\n${second.out}`);
    assert.match(second.out, /already staged \+ verified/);
    assert.match(second.out, /bundled-models\.json already current/);
    assert.equal(server.requests.length - requestsAfterFirst, 0, 'the second run must not fetch');
    for (const [name, mtime] of mtimes) {
      assert.equal(fs.statSync(path.join(out, name)).mtimeMs, mtime, `${name} must not be rewritten`);
    }
  } finally {
    await server.close();
  }
});

test('redirects are followed and every hop host is validated', async () => {
  const dir = scratch('txr-bundle-');
  const manifest = one_entry_manifest(dir);
  const out = path.join(dir, 'out');
  const doc = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const url = new URL(doc.models[0].url);
  const good = fs.readFileSync(path.join(FIXTURE_ASSETS, doc.models[0].file));

  const ok = await start_server({
    [url.pathname]: { redirect: `/moved/${doc.models[0].file}` },
    [`/moved/${doc.models[0].file}`]: { body: good },
  });
  try {
    const r = await run(['--manifest', manifest, '--out', out, '--base-url', `http://127.0.0.1:${ok.port}`]);
    assert.equal(r.status, 0, `expected exit 0:\n${r.out}`);
    assert.equal(sha256(fs.readFileSync(path.join(out, doc.models[0].file))), doc.models[0].sha256);
    assert.deepEqual(ok.requests.map((q) => q.url), [url.pathname, `/moved/${doc.models[0].file}`]);
  } finally {
    await ok.close();
  }

  const bad = await start_server({ [url.pathname]: { redirect: 'http://evil.invalid/final.txr' } });
  try {
    const r = await run([
      '--manifest', manifest, '--out', path.join(dir, 'out2'),
      '--base-url', `http://127.0.0.1:${bad.port}`,
    ]);
    assert.equal(r.status, 1, `expected exit 1:\n${r.out}`);
    assert.match(r.out, /redirect target host evil\.invalid is outside/);
  } finally {
    await bad.close();
  }
});

// ── manifest validation ─────────────────────────────────────────────────────────
test('a malformed or incomplete manifest is refused with the entry named', async () => {
  const dir = scratch('txr-bundle-');
  const out = path.join(dir, 'out');

  const badSha = one_entry_manifest(dir, { sha256: 'not-hex' });
  const r1 = await run(['--manifest', badSha, '--out', out]);
  assert.equal(r1.status, 1);
  assert.match(r1.out, /not 64 lowercase hex/);

  const noSize = one_entry_manifest(dir, {});
  const doc = JSON.parse(fs.readFileSync(noSize, 'utf8'));
  delete doc.models[0].size_bytes;
  fs.writeFileSync(noSize, `${JSON.stringify(doc, null, 1)}\n`);
  const r2 = await run(['--manifest', noSize, '--out', out]);
  assert.equal(r2.status, 1);
  assert.match(r2.out, /incomplete \(missing size_bytes\)/);

  const badFile = one_entry_manifest(dir, { file: 'renamed@0.4.0.txr' });
  const r3 = await run(['--manifest', badFile, '--out', out]);
  assert.equal(r3.status, 1);
  assert.match(r3.out, /expected relchange-threshold@0\.4\.0\.txr/);

  const badSchema = write_manifest(dir, [], { schema_version: 2 });
  const r4 = await run(['--manifest', badSchema, '--out', out]);
  assert.equal(r4.status, 1);
  assert.match(r4.out, /unsupported manifest schema_version 2/);
});
