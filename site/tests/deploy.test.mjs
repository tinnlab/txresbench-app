/**
 * deploy.test.mjs — landing-site ITEM-6 suite, deploy-side assertions.
 * Plain node:test, zero deps (node builtins only). TESTS.md TEST-17
 * (pages.yml.disabled: triggers, build command, deploy-pages artifact
 * wiring, disabled-by-filename) and TEST-18 (the node's diff surface —
 * no src-app/ path at the item round and over the whole node diff from
 * its base — plus the site/README.md runbook's canonical URLs and
 * owner-gated enable step).
 *
 * Run: node --test 'site/tests/*.test.mjs'   (from the repo root)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WORKFLOW = join(ROOT, '.github', 'workflows', 'pages.yml.disabled');
const README = join(ROOT, 'site', 'README.md');

// The node's additive diff surface (PLAN "Files to touch"): the site tree,
// the build script, the parked workflow, the .gitignore edit — plus the
// node's own ledger under .lifecycle/txresbench-app/landing-site/, which
// every item of this branch commits with it (PLAN note n).
const ALLOWED_PREFIXES = [
  'site/',
  'scripts/build-landing-site.mjs',
  '.github/workflows/pages.yml.disabled',
  '.lifecycle/txresbench-app/landing-site/',
  '.gitignore',
];

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/**
 * The paths the current round changes: the working-tree diff plus untracked
 * files (a fresh ITEM-6 file is untracked until committed). When the tree is
 * clean the round's own diff is the most recent commit (the gate also runs
 * after the commit, where `git diff HEAD` is empty by definition).
 */
function roundDiff() {
  const diff = git(['diff', '--name-only', '-z', 'HEAD']);
  assert.equal(diff.code, 0, `git diff HEAD failed: ${diff.stderr}`);
  const tracked = diff.stdout.split('\0').filter(Boolean);

  const status = git(['status', '--porcelain', '-z']);
  assert.equal(status.code, 0, `git status --porcelain failed: ${status.stderr}`);
  const untracked = [];
  for (const rec of status.stdout.split('\0').filter(Boolean)) {
    const kind = rec.slice(0, 2);
    const path = rec.slice(3);
    if (kind === '??') untracked.push(path); // '!!' (ignored) and edits are covered above
  }

  const round = [...new Set([...tracked, ...untracked])].sort();
  if (round.length === 0) {
    const last = git(['diff', '--name-only', '-z', 'HEAD~1', 'HEAD']);
    assert.equal(last.code, 0, `git diff HEAD~1..HEAD failed: ${last.stderr}`);
    return { base: 'HEAD~1..HEAD', paths: last.stdout.split('\0').filter(Boolean).sort() };
  }
  return { base: `working tree vs HEAD${untracked.length ? ' + untracked' : ''}`, paths: round };
}

test('TEST-17 pages.yml.disabled: disabled deploy-pages workflow for the site', () => {
  assert.ok(existsSync(WORKFLOW), '.github/workflows/pages.yml.disabled exists');
  // disabled by filename — nothing runs until the owner's enable step
  assert.ok(WORKFLOW.endsWith('.disabled'), 'the workflow file is parked (ends in .disabled)');
  assert.ok(!existsSync(join(ROOT, '.github', 'workflows', 'pages.yml')),
    'no active pages.yml — the workflow only runs after the owner renames it');

  const yml = readFileSync(WORKFLOW, 'utf8');

  // triggers: push of an app-v* tag + workflow_dispatch (PROV-landing-site-8)
  const push = /on:[\s\S]*?push:\s*\n\s*tags:[\s\S]*?-\s*['"]?app-v\*['"]?/;
  assert.ok(push.test(yml), 'trigger: push of an app-v* tag');
  assert.ok(/on:[\s\S]*?workflow_dispatch/.test(yml), 'trigger: workflow_dispatch');
  assert.ok(!/push:\s*\n\s*branches:/.test(yml),
    'no push-to-branch trigger (content changes are the owner\'s production steps)');

  // the build is the site's own zero-dep build, and the artifact is site/dist
  assert.ok(yml.includes('node scripts/build-landing-site.mjs'),
    'the workflow builds with node scripts/build-landing-site.mjs');
  assert.ok(/actions\/upload-pages-artifact@[\w]+/.test(yml), 'uploads via actions/upload-pages-artifact');
  const upload = /actions\/upload-pages-artifact@[\w]+[\s\S]*?path:\s*site\/dist/;
  assert.ok(upload.test(yml), 'the published artifact path is site/dist');
  assert.ok(/actions\/deploy-pages@[\w]+/.test(yml), 'deploys via actions/deploy-pages');

  // a deploy needs the standard Pages permissions; a workflow that could not
  // run would make the enable step a failure at the owner's go
  assert.ok(/permissions:[\s\S]*?pages:\s*write/.test(yml), 'permissions.pages: write');
  assert.ok(/permissions:[\s\S]*?id-token:\s*write/.test(yml), 'permissions.id-token: write');
});

test('TEST-18 the node\'s diff surface is additive and never touches src-app/', () => {
  // INV-3: nothing under src-app/ — at the item round AND over the node's
  // whole diff from its base (the parent of the first ITEM-1 commit).
  const { base, paths } = roundDiff();
  for (const p of paths) {
    assert.ok(!p.startsWith('src-app/'), `${base}: path under src-app/: ${p}`);
    const allowed = ALLOWED_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix));
    assert.ok(allowed, `${base}: path outside the node's file list: ${p}`);
  }

  // the node's whole diff: from the node base (the parent of the first
  // landing-site: ITEM-1 commit — the "method-env-images merged" base
  // recorded at ITEM-1) to HEAD. The branch's own history contains the
  // earlier epic nodes' src-app work (the TxResBench shell conversion), so
  // `main` is NOT this node's delimiter; the node base is (PLAN note n).
  const first = git(['log', '--reverse', '--format=%H', '--grep=landing-site: ITEM-1 ', 'HEAD']);
  assert.equal(first.code, 0, `git log failed: ${first.stderr}`);
  const firstLines = first.stdout.split('\n').filter(Boolean);
  assert.ok(firstLines.length > 0,
    'no "landing-site: ITEM-1" commit in this branch\'s history — the suite must run on the node branch');
  const baseCommit = git(['rev-parse', `${firstLines[0]}^`]);
  assert.equal(baseCommit.code, 0, `cannot resolve the node base commit: ${baseCommit.stderr}`);
  const branch = git(['diff', '--name-only', '-z', baseCommit.stdout.trim(), 'HEAD']);
  assert.equal(branch.code, 0, `git diff <node-base>..HEAD failed: ${branch.stderr}`);
  const branchPaths = branch.stdout.split('\0').filter(Boolean);
  assert.ok(branchPaths.length > 0, 'the node actually differs from its base (diff base sanity)');
  for (const p of branchPaths) {
    assert.ok(!p.startsWith('src-app/'), `node diff contains a src-app/ path: ${p} (INV-3)`);
    const allowed = ALLOWED_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix));
    assert.ok(allowed, `node diff path outside the node's file list: ${p}`);
  }
});

test('TEST-18 site/README.md runbook: canonical URLs + owner-gated enable step', () => {
  assert.ok(existsSync(README), 'site/README.md exists (the node\'s runbook)');
  const md = readFileSync(README, 'utf8');

  // the three canonical URLs, byte-exact (TEST-10's --print-urls set)
  const urls = [
    'https://tinnlab.github.io/txresbench-app/',
    'https://tinnlab.github.io/txresbench-app/updates/latest.json',
    'https://tinnlab.github.io/txresbench-app/pretrained-catalogue.json',
  ];
  for (const u of urls) {
    assert.ok(md.includes(u), `runbook names the canonical URL ${u}`);
  }

  // the owner-gated enable step: the parked workflow is renamed by the owner
  assert.ok(/owner-gated/i.test(md), 'the runbook states the deploy is owner-gated');
  assert.ok(md.includes('pages.yml.disabled') && md.includes('git mv'),
    'the runbook names the disabled workflow and the rename (enable) step');
  assert.ok(/GitHub Actions/i.test(md), 'the runbook names the Pages source choice (GitHub Actions)');
  // and the producer side: the runbook explains who writes the two feeds
  assert.ok(md.includes('pretrained-catalogue.json') && md.includes('updates/latest.json'),
    'the runbook documents the catalogue and update-feed files');
});
