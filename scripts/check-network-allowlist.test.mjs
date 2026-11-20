#!/usr/bin/env node
// check-network-allowlist.test.mjs — negative controls for
// `scripts/check-network-allowlist.sh`.
//
// Each assertion drives the REAL guard as a subprocess over a synthetic fixture
// tree and reads the process's OWN exit status (never a piped `$?`).
//
//   node --test scripts/check-network-allowlist.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SCRIPTS_DIR, '..');
const GUARD = path.join(SCRIPTS_DIR, 'check-network-allowlist.sh');

function run(allowlist, roots, locks, extraArgs = []) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'netguard-'));
  const aFile = path.join(dir, 'allowlist.txt');
  fs.writeFileSync(aFile, allowlist);
  const r = spawnSync(
    'bash',
    [GUARD, `--allowlist=${aFile}`, `--roots=${roots.join(',')}`, `--locks=${locks.join(',')}`, ...extraArgs],
    { cwd: REPO, encoding: 'utf-8' },
  );
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const EMPTY_LOCKS = process.env.TMPDIR
  ? []
  : [];

function fixtureTree(files) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'netguard-src-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

// A synthetic lockfile with no telemetry names anywhere.
const CLEAN_LOCK = `# nothing to see
[[package]]
name = "axum"
version = "0.8.4"
`;

test('passes on a clean tree (loopback + allowlisted host only)', () => {
  const src = fixtureTree({
    'src/main.rs': 'const A: &str = "http://127.0.0.1:3100/api";\nconst B: &str = "https://ghcr.io/org/env";\n',
  });
  const locks = fixtureTree({ 'Cargo.lock': CLEAN_LOCK });
  const r = run('ghcr.io\n', [path.join(src, 'src')], [path.join(locks, 'Cargo.lock')]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

test('ignores hosts inside comments and #[cfg(test)] blocks', () => {
  const src = fixtureTree({
    'src/main.rs': [
      '// fetch from https://evil-attacker.example-corp.com/annotate',
      '/// https://doc.example-corpx.com',
      '',
      '#[cfg(test)]',
      'mod tests {',
      '    const URL: &str = "https://testonly.example-corpx.com/path";',
      '}',
      '',
      'const OK: &str = "http://localhost:1234";',
      '',
    ].join('\n'),
  });
  const locks = fixtureTree({ 'Cargo.lock': CLEAN_LOCK });
  const r = run('', [path.join(src, 'src')], [path.join(locks, 'Cargo.lock')]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

test('fails when non-test source adds a host outside the allowlist', () => {
  const src = fixtureTree({
    'src/main.rs': 'const U: &str = "https://telemetry.example-corp.com/collect";\n',
  });
  const locks = fixtureTree({ 'Cargo.lock': CLEAN_LOCK });
  const r = run('ghcr.io\n', [path.join(src, 'src')], [path.join(locks, 'Cargo.lock')]);
  assert.equal(r.status, 1, 'guard must fail on a new host');
  assert.match(r.stderr, /telemetry\.example-corp\.com/);
});

test('fails when a telemetry crate appears in a lockfile', () => {
  const src = fixtureTree({
    'src/main.rs': 'const U: &str = "http://127.0.0.1:3100/api";\n',
  });
  const locks = fixtureTree({
    'Cargo.lock': `[[package]]
name = "sentry"
version = "0.36.0"
`,
  });
  const r = run('', [path.join(src, 'src')], [path.join(locks, 'Cargo.lock')]);
  assert.equal(r.status, 1, 'guard must fail on a telemetry crate');
  assert.match(r.stderr, /sentry/);
});

test('fails when a telemetry package appears in an npm lockfile', () => {
  const src = fixtureTree({
    'src/ui.ts': 'const U = await fetch(`http://127.0.0.1:3100/api`)\n',
  });
  const locks = fixtureTree({
    'package-lock.json': `{
  "name": "x",
  "packages": {
    "node_modules/posthog-js": { "version": "1.0.0" }
  }
}
`,
    'Cargo.lock': CLEAN_LOCK,
  });
  const r = run('', [path.join(src, 'src')], [
    path.join(locks, 'Cargo.lock'),
    path.join(locks, 'package-lock.json'),
  ]);
  assert.equal(r.status, 1, 'guard must fail on a telemetry npm package');
  assert.match(r.stderr, /posthog/);
});

test('does not trip on names that merely contain telemetry substrings', () => {
  const src = fixtureTree({
    'src/main.rs': 'const U: &str = "http://127.0.0.1:3100/api";\n',
  });
  const locks = fixtureTree({
    'Cargo.lock': `[[package]]
name = "overlayscrollbars"
version = "2.0.0"
[[package]]
name = "line-segment"
version = "1.0.0"
`,
  });
  const r = run('', [path.join(src, 'src')], [path.join(locks, 'Cargo.lock')]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

// ---- stale allowlist entries (D9) -------------------------------------------------

test('fails on an allowlist entry that matches nothing in the scan roots', () => {
  const src = fixtureTree({
    'src/main.rs': 'const U: &str = "http://127.0.0.1:3100/api";\n',
  });
  const locks = fixtureTree({ 'Cargo.lock': CLEAN_LOCK });
  const r = run('unused.example-corp.com\n', [path.join(src, 'src')], [path.join(locks, 'Cargo.lock')]);
  assert.equal(r.status, 1, 'guard must fail on a stale entry');
  assert.match(r.stderr, /STALE\s+unused\.example-corp\.com/);
});

test('an entry tagged `# scheme-less` may match nothing; an untagged one may not', () => {
  const src = fixtureTree({
    'src/main.rs': 'const U: &str = "http://127.0.0.1:3100/api";\n',
  });
  const locks = fixtureTree({ 'Cargo.lock': CLEAN_LOCK });
  const lock = path.join(locks, 'Cargo.lock');
  const tagged = run('registry.example-corp.com # scheme-less\n', [path.join(src, 'src')], [lock]);
  assert.equal(tagged.status, 0, tagged.stderr || tagged.stdout);
  const untagged = run('registry.example-corp.com # a registry\n', [path.join(src, 'src')], [lock]);
  assert.equal(untagged.status, 1, 'a comment without the tag does not exempt an entry');
});

test('the shipped allowlist has no stale entry and tags only the three scheme-less hosts', () => {
  const text = fs.readFileSync(path.join(SCRIPTS_DIR, 'network-allowlist.txt'), 'utf-8');
  const tagged = text
    .split('\n')
    .filter((l) => !l.trim().startsWith('#') && /#\s*scheme-less/.test(l))
    .map((l) => l.split('#')[0].trim())
    .sort();
  assert.deepEqual(tagged, ['ghcr.io', 'objects.githubusercontent.com', 'pkg-containers.githubusercontent.com']);
});

// ---- derived scan roots (D8) ------------------------------------------------------

// A copy of the guard placed in a synthetic repo, so its DEFAULT roots are derived from that
// repo's layout. Nothing is passed with --roots.
function syntheticRepo(files) {
  const repo = fixtureTree({
    'src-app/server/src/main.rs': '// none\n',
    'src-app/desktop/tauri/src/main.rs': '// none\n',
    'src-app/ui/src/index.ts': '// none\n',
    'sdk/desktop/harness/src/lib.rs': '// none\n',
    'sdk/packages/framework/src/index.ts': '// none\n',
    'sdk/packages/kit/src/index.ts': '// none\n',
    'sdk/packages/shell/src/index.ts': '// none\n',
    'Cargo.lock': CLEAN_LOCK,
    ...files,
  });
  fs.mkdirSync(path.join(repo, 'scripts'));
  fs.copyFileSync(GUARD, path.join(repo, 'scripts', 'check-network-allowlist.sh'));
  return repo;
}

function runDefault(repo) {
  const aFile = path.join(repo, 'allow.txt');
  fs.writeFileSync(aFile, '');
  const r = spawnSync(
    'bash',
    [path.join(repo, 'scripts', 'check-network-allowlist.sh'), `--allowlist=${aFile}`, `--locks=${path.join(repo, 'Cargo.lock')}`],
    { cwd: repo, encoding: 'utf-8' },
  );
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const BAD = 'https://leak.example-corp.com/x';

test('default roots: a clean synthetic repo passes (the control for the cases below)', () => {
  const r = runDefault(syntheticRepo({ 'sdk/crates/a-crate/src/lib.rs': 'const A: u8 = 1;\n' }));
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

for (const [name, rel] of [
  ['a new SDK crate (any name)', 'sdk/crates/brand-new-crate/src/lib.rs'],
  ['a per-OS Tauri config', 'src-app/desktop/tauri/tauri.macos.conf.json'],
  ['a second per-OS Tauri config', 'src-app/desktop/tauri/tauri.windows.conf.json'],
  ['a capability file', 'src-app/desktop/tauri/capabilities/extra.json'],
  ['the server build.rs', 'src-app/server/build.rs'],
  ['the desktop build.rs', 'src-app/desktop/tauri/build.rs'],
  ['an SDK crate build.rs', 'sdk/crates/brand-new-crate/build.rs'],
]) {
  test(`default roots: a host in ${name} is scanned without editing the guard`, () => {
    const repo = syntheticRepo({
      'sdk/crates/brand-new-crate/src/lib.rs': '// none\n',
      [rel]: rel.endsWith('.json') ? `{"url": "${BAD}"}\n` : `const U: &str = "${BAD}";\n`,
    });
    const r = runDefault(repo);
    assert.equal(r.status, 1, `host in ${rel} must be found`);
    assert.match(r.stderr, /leak\.example-corp\.com/);
  });
}
