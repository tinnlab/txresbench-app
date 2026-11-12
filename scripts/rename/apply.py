#!/usr/bin/env python3
"""apply.py: rewrite the identifiers inherited from the SDK and the single-cell predecessor of this app to TxResBench names.

  python3 scripts/rename/apply.py [--root DIR] [--dry-run] [--collisions]      forward: the rules below, over every tracked text file
  python3 scripts/rename/apply.py --reverse [--root DIR]                        best effort, sdk/ only: TxResBench names back to the
                                                                                SDK's names, for porting a change in sdk/ upstream

Forward rules run in order; paths (files and directories) are renamed with the same rules, component by component. Licence and
notice files, this tool and its map are never rewritten. Binary files are skipped."""
import argparse, os, re, subprocess, sys, collections

FORWARD = [
    (r'ghcr\.io/ziee-ai/cyto-env', 'ghcr.io/tinnlab/txresbench-env'),
    (r'github\.com/ziee-ai/', 'github.com/tinnlab/'),
    (r'(?<![A-Za-z0-9])ziee-ai(?![A-Za-z0-9])', 'tinnlab'),
    (r'(?<![A-Za-z])cyto-env(?![A-Za-z])', 'txresbench-env'),
    (r'com\.cytoanalyst\.env', 'com.txresbench.env'),
    (r'vnd\.cyto\.env', 'vnd.txresbench.env'),
    (r'@cyto\.test', '@txresbench.test'),
    (r'@Cyto\.TEST', '@Txresbench.TEST'),
    (r'@CYTO\.test', '@TXRESBENCH.test'),
    (r'@cytoanalyst/', '@txresbench/'),
    (r'@cyto/', '@txresbench/'),
    (r'@ziee/', '@txresbench/'),
    (r'@cyto(?![A-Za-z0-9/._-])', '@txresbench'),
    (r'cytoanalyst-desktop', 'txresbench-desktop'),
    (r'cytoanalyst_desktop_lib', 'txresbench_desktop_lib'),
    (r'cytoanalyst-root', 'txresbench-root'),
    (r'CytoAnalyst|Cytoanalyst', 'TxResBench'),
    (r'CYTOANALYST', 'TXRESBENCH'),
    (r'cytoanalyst', 'txresbench'),
    (r'CYTO_TXR_', 'TXR_'),
    (r'(?<![A-Za-z0-9])(?:CYTO|ZIEE)_', 'TXR_'),
    (r'(?<=\\n)(?:CYTO|ZIEE)_', 'TXR_'),
    (r'Ziee(?=[A-Z])', 'TxResBench'),
    (r'(?<![A-Za-z])Ziee(?![A-Za-z])( AI)?', 'TxResBench'),
    (r'(?<![A-Za-z])ZIEE(?![A-Za-z])', 'TXRESBENCH'),
    (r'(?<![A-Za-z])ziee(?![A-Za-z])', 'txresbench'),
    (r'(?<=\\n)ziee(?![A-Za-z])', 'txresbench'),
    (r'(?<![A-Za-z0-9_-])CYTO(?=[ -](?:BACKEND|FRONTEND|LOCAL))', 'TXRESBENCH'),
    (r'(?<![A-Za-z])Cyto(?![A-Za-z])', 'TxResBench'),
    (r'(?<![A-Za-z])cyto(?![A-Za-z])', 'txr'),
    (r'(?<=\\n)cyto(?![A-Za-z])', 'txr'),
]
# best-effort inverse for sdk/ (the SDK's own names)
REVERSE = [
    (r'@txresbench/', '@ziee/'), (r'(?<![A-Za-z0-9])txresbench-(?=[a-z])', 'ziee-'), (r'(?<![A-Za-z0-9])txresbench_', 'ziee_'),
    (r'TxResBench(?=[A-Z])', 'Ziee'), (r'(?<![A-Za-z0-9])TXR_', 'ZIEE_'), (r'tinnlab', 'ziee-ai'),
]
SKIP_NAMES = ('LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md')
SKIP_PATHS = ('.lifecycle/', 'scripts/rename/', 'sdk/RENAME-MAP.md', 'sdk/CONTRIBUTING-UPSTREAM.md')

def skip(path):
    base = os.path.basename(path)
    return path.startswith(SKIP_PATHS) or any(base.startswith(n) for n in SKIP_NAMES)

def apply(text, rules):
    for pat, rep in rules:
        text = re.sub(pat, rep, text)
    return text

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default='.'); ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--reverse', action='store_true'); ap.add_argument('--collisions', action='store_true')
    a = ap.parse_args(); os.chdir(a.root)
    rules = [(re.compile(p), r) for p, r in (REVERSE if a.reverse else FORWARD)]
    files = subprocess.run(['git', 'ls-files', '-z'], capture_output=True, check=True).stdout.decode().split('\0')
    files = [f for f in files if f and not os.path.islink(f) and not skip(f) and (not a.reverse or f.startswith('sdk/'))]
    counts = collections.Counter(); changed = []; skipped = []; seen = collections.defaultdict(set)
    for f in files:
        try:
            raw = open(f, 'rb').read()
        except OSError:
            continue
        if b'\0' in raw[:8192]:
            continue
        try:
            text = raw.decode('utf-8')
        except UnicodeDecodeError:
            skipped.append(f); continue
        new = text
        for rx, rep in rules:
            def sub(m, rep=rep, rx=rx):
                out = m.expand(rep) if '\\' in rep else rep
                counts[rx.pattern] += 1
                if a.collisions: seen[out].add(m.group(0))
                return out
            new = rx.sub(sub, new)
        if new != text:
            changed.append(f)
            if not a.dry_run:
                with open(f, 'wb') as fh: fh.write(new.encode('utf-8'))
    # paths: rename every tracked path whose components change (deepest first), with the same rules
    moves = []
    for f in files:
        n = '/'.join(apply(c, [(rx, r) for rx, r in rules]) for c in f.split('/'))
        if n != f: moves.append((f, n))
    if a.collisions:
        # distinct old tokens mapping to the same new token for the environment variable rules
        env = collections.defaultdict(set)
        for f in files:
            try: t = open(f, encoding='utf-8').read()
            except Exception: continue
            for m in re.finditer(r'(?:CYTO_TXR_|CYTO_|ZIEE_)[A-Z0-9_]+', t):
                old = m.group(0); env[re.sub(r'^(CYTO_TXR_|CYTO_|ZIEE_)', 'TXR_', old)].add(old)
        bad = {k: sorted(v) for k, v in env.items() if len(v) > 1}
        print('env variable collisions:', len(bad))
        for k, v in list(bad.items())[:20]: print(' ', k, '<-', v)
        pc = collections.defaultdict(set)
        for o, n in moves: pc[n].add(o)
        print('path collisions:', sum(1 for v in pc.values() if len(v) > 1))
    if not a.dry_run:
        for o, n in sorted(moves, key=lambda x: -x[0].count('/')):
            os.makedirs(os.path.dirname(n) or '.', exist_ok=True)
            subprocess.run(['git', 'mv', o, n], check=True)
    print(f'files rewritten: {len(changed)}  paths renamed: {len(moves)}  undecodable skipped: {len(skipped)}')
    for p, c in counts.most_common(): print(f'  {c:7d}  {p}')
if __name__ == '__main__': main()
