// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { checkCandidate, exportCandidate, indexFiles } from '../../scripts/candidate-snapshot.mjs';
import { scanPublicFiles } from '../../scripts/public-content-check.mjs';

const source = resolve(import.meta.dirname, '../..');

function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-candidate-'));
  const repo = join(dir, 'source');
  const candidate = join(dir, 'candidate');
  const manifest = join(dir, 'manifest.json');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init', '-q');
  writeFileSync(join(repo, '.gitignore'), 'node_modules\nignored.txt\n');
  writeFileSync(join(repo, 'README.md'), 'A reusable organisational project.\n');
  git('add', '.');
  try {
    run({ dir, repo, candidate, manifest, git });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('export and verify exact staged paths, modes, bytes and internal skill link', () =>
  fixture(({ dir, repo, candidate, manifest, git }) => {
    mkdirSync(join(repo, '.claude/skills'), { recursive: true });
    mkdirSync(join(repo, '.codex'));
    writeFileSync(join(repo, '.claude/skills/SKILL.md'), 'A portable skill.\n');
    symlinkSync('../.claude/skills', join(repo, '.codex/skills'));
    writeFileSync(join(repo, 'run.sh'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(repo, 'run.sh'), 0o755);
    symlinkSync(dir, join(repo, 'node_modules'));
    git('add', '.');
    const result = exportCandidate(repo, candidate, manifest);
    assert.equal(result.kind, 'local-candidate-files');
    assert.equal(result.files.length, 5);
    assert.equal(result.files.find(({ path }) => path === 'run.sh').mode, '100755');
    assert.equal(result.files.find(({ path }) => path === '.codex/skills').mode, '120000');
    assert.equal(existsSync(join(candidate, '.git')), false);
    assert.equal(existsSync(join(candidate, 'node_modules')), false);
    checkCandidate(candidate, manifest);
    const second = exportCandidate(repo, join(dir, 'second'), join(dir, 'second.json'));
    assert.deepEqual(result, second, 'manifest identity is deterministic');
  }));

for (const [label, mutate] of [
  ['changed bytes', (path) => writeFileSync(join(path, 'README.md'), 'changed')],
  ['extra untracked file', (path) => writeFileSync(join(path, 'extra.txt'), 'extra')],
  ['extra ignored file', (path) => writeFileSync(join(path, 'ignored.txt'), 'extra')],
  ['changed mode', (path) => chmodSync(join(path, 'README.md'), 0o755)],
  ['Git history directory', (path) => mkdirSync(join(path, '.git'))],
]) {
  test(`verification rejects ${label}`, () =>
    fixture(({ repo, candidate, manifest }) => {
      exportCandidate(repo, candidate, manifest);
      mutate(candidate);
      assert.throws(() => checkCandidate(candidate, manifest));
    }));
}

test('export refuses index and worktree divergence', () =>
  fixture(({ repo, candidate, manifest }) => {
    writeFileSync(join(repo, 'README.md'), 'unstaged change');
    assert.throws(() => exportCandidate(repo, candidate, manifest), /index and worktree differ/u);
    assert.equal(existsSync(candidate), false);
  }));

test('export refuses an untracked input file', () =>
  fixture(({ repo, candidate, manifest }) => {
    writeFileSync(join(repo, 'untracked.txt'), 'untracked');
    assert.throws(() => exportCandidate(repo, candidate, manifest), /untracked/u);
  }));

test('export refuses force-staged ignored files', () =>
  fixture(({ repo, candidate, manifest, git }) => {
    writeFileSync(join(repo, 'ignored.txt'), 'ignored');
    git('add', '-f', 'ignored.txt');
    assert.throws(() => exportCandidate(repo, candidate, manifest), /ignored/u);
  }));

for (const target of ['../escape', '/tmp', 'missing']) {
  test('export refuses an escaping, absolute or dangling link', () =>
    fixture(({ repo, candidate, manifest, git }) => {
      symlinkSync(target, join(repo, 'link'));
      git('add', 'link');
      assert.throws(() => exportCandidate(repo, candidate, manifest));
    }));
}

test('export refuses symlink ancestors in the worktree', () =>
  fixture(({ dir, repo, candidate, manifest, git }) => {
    mkdirSync(join(repo, 'sub'));
    writeFileSync(join(repo, 'sub/file'), 'same');
    git('add', '.');
    mkdirSync(join(dir, 'outside'));
    writeFileSync(join(dir, 'outside/file'), 'same');
    rmSync(join(repo, 'sub'), { recursive: true });
    symlinkSync(join(dir, 'outside'), join(repo, 'sub'));
    assert.throws(() => exportCandidate(repo, candidate, manifest), /untracked|symlink ancestor/u);
  }));

test('manifest and export destinations must be external and new', () =>
  fixture(({ dir, repo, candidate, manifest }) => {
    assert.throws(() => exportCandidate(repo, join(repo, 'candidate'), manifest), /outside/u);
    assert.throws(() => exportCandidate(repo, candidate, join(repo, 'manifest.json')), /outside/u);
    mkdirSync(candidate);
    assert.throws(() => exportCandidate(repo, candidate, manifest), /new file/u);
    symlinkSync(repo, join(dir, 'alias'));
    assert.throws(
      () => exportCandidate(repo, join(dir, 'other'), join(dir, 'alias/manifest.json')),
      /outside/u,
    );
  }));

test('manifest tampering fails verification', () =>
  fixture(({ repo, candidate, manifest }) => {
    exportCandidate(repo, candidate, manifest);
    const doc = JSON.parse(readFileSync(manifest, 'utf8'));
    doc.treeSha256 = '0'.repeat(64);
    writeFileSync(manifest, JSON.stringify(doc));
    assert.throws(() => checkCandidate(candidate, manifest), /differs/u);
  }));

const prohibited = [
  ['private-pitch-url', ['https:/', '/pitch', '.example.invalid/private'].join('')],
  ['commercial-proposal', [['spon', 'sor'].join(''), 'proposal'].join(' ')],
  ['commercial-proposal', ['funding', 'round'].join(' ')],
  ['personal-path', ['/', 'Users', '/fixture-person/private'].join('')],
  ['excluded-token', ['synthetic', 'public', 'client'].join('')],
];
for (const [rule, value] of prohibited) {
  test(`public content rejects ${rule} without printing the matched value`, () => {
    const findings = scanPublicFiles([{ path: 'fixture.md', bytes: Buffer.from(value) }]);
    assert.ok(findings.some((finding) => finding.rule === rule));
    assert.ok(!JSON.stringify(findings).includes(value));
  });
}

test('a prohibited filename is withheld from findings', () => {
  const filename = ['synthetic', 'public', 'client.md'].join('');
  const findings = scanPublicFiles([{ path: filename, bytes: Buffer.from('ordinary text') }]);
  assert.deepEqual(findings, [{ file: '<withheld-path>', rule: 'excluded-token' }]);
});

test('public guard accepts neutral source and licence text and rejects binary input', () => {
  assert.deepEqual(
    scanPublicFiles([
      {
        path: 'README.md',
        bytes: Buffer.from(
          'Tasks, approvals and documentation. Copyright and licence terms remain intact.',
        ),
      },
    ]),
    [],
  );
  assert.equal(
    scanPublicFiles([{ path: 'image.dat', bytes: Buffer.from([0xff]) }])[0].rule,
    'non-text-foundation-file',
  );
});

test('public guard reads staged content through its CLI', () =>
  fixture(({ repo, git }) => {
    writeFileSync(join(repo, 'README.md'), prohibited[0][1]);
    git('add', '.');
    assert.equal(scanPublicFiles(indexFiles(repo)).length, 1);
    const result = spawnSync(
      process.execPath,
      [join(source, 'scripts/public-content-check.mjs'), '--repo', repo],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /README.md \[private-pitch-url\]/u);
    assert.ok(!result.stderr.includes(prohibited[0][1]));
  }));

test('receipt requires external output and rejects inherited fixture history', () =>
  fixture(({ dir, repo, git }) => {
    mkdirSync(join(repo, 'scripts'));
    for (const file of [
      'publication-receipt.sh',
      'publication-receipt.mjs',
      'candidate-snapshot.mjs',
    ]) {
      writeFileSync(join(repo, 'scripts', file), readFileSync(join(source, 'scripts', file)));
    }
    git('add', '.');
    const commit = () =>
      git(
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-qm',
        'chore: disposable receipt fixture',
      );
    commit();
    writeFileSync(join(repo, 'README.md'), 'Second disposable fixture revision.');
    git('add', '.');
    commit();
    const run = (args) =>
      spawnSync('bash', [join(repo, 'scripts/publication-receipt.sh'), ...args], {
        cwd: repo,
        encoding: 'utf8',
      });
    assert.equal(run([]).status, 2);
    assert.equal(
      run(['--first-root', '--ref', 'HEAD', '--output', join(repo, 'forbidden-receipt.md')]).status,
      2,
    );
    assert.equal(existsSync(join(repo, 'forbidden-receipt.md')), false);
    const output = join(dir, 'receipt.md');
    assert.equal(run(['--first-root', '--ref', 'HEAD', '--output', output]).status, 1);
    const receipt = readFileSync(output, 'utf8');
    assert.match(receipt, /Reachable commits: 2/u);
    assert.match(receipt, /NOT RUN/u);
    assert.match(receipt, /not verified by this command/u);
    assert.doesNotMatch(receipt, /No workflow has ever run|No message has reached/u);
    assert.equal(git('status', '--porcelain').toString(), '', 'receipt does not dirty its subject');
  }));

test('only the exact inherited synthetic shape fixture has a path-shape exception', () => {
  const path = 'tests/gate/shape-canary.txt';
  const bytes = readFileSync(join(source, path));
  assert.deepEqual(scanPublicFiles([{ path, bytes }]), []);
  assert.ok(
    scanPublicFiles([{ path, bytes: Buffer.concat([bytes, Buffer.from('\nchanged')]) }]).some(
      ({ rule }) => rule === 'personal-path',
    ),
  );
  assert.ok(
    scanPublicFiles([{ path: 'copied-fixture.txt', bytes }]).some(
      ({ rule }) => rule === 'personal-path',
    ),
  );
});

test('CLI validation errors do not expose malformed manifest contents or private paths', () =>
  fixture(({ dir, repo, candidate, manifest }) => {
    exportCandidate(repo, candidate, manifest);
    const withheld = 'SYNTHETIC_WITHHELD_VALUE';
    writeFileSync(manifest, withheld);
    for (const script of ['candidate-snapshot.mjs', 'public-content-check.mjs']) {
      const args = script.startsWith('candidate') ? ['check'] : [];
      const result = spawnSync(
        process.execPath,
        [
          join(source, 'scripts', script),
          ...args,
          '--candidate',
          candidate,
          '--manifest',
          manifest,
        ],
        { encoding: 'utf8' },
      );
      assert.equal(result.status, 1);
      assert.ok(!result.stderr.includes(withheld));
      assert.ok(!result.stderr.includes(dir));
    }
    const result = spawnSync(
      process.execPath,
      [join(source, 'scripts/public-content-check.mjs'), '--repo', candidate],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.ok(!result.stderr.includes(dir));
  }));

test('receipt refuses an annotated tag before running scans or writing a receipt', () =>
  fixture(({ dir, repo, git }) => {
    mkdirSync(join(repo, 'scripts'));
    for (const file of [
      'publication-receipt.sh',
      'publication-receipt.mjs',
      'candidate-snapshot.mjs',
    ]) {
      writeFileSync(join(repo, 'scripts', file), readFileSync(join(source, 'scripts', file)));
    }
    git('add', '.');
    git(
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'chore: disposable tag receipt fixture',
    );
    git(
      '-c',
      'tag.gpgsign=false',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'tag',
      '-am',
      'Synthetic annotated metadata',
      'annotated',
    );
    const output = join(dir, 'tag-receipt.md');
    const result = spawnSync(
      'bash',
      [
        join(repo, 'scripts/publication-receipt.sh'),
        '--first-root',
        '--ref',
        'annotated',
        '--output',
        output,
      ],
      { cwd: repo, encoding: 'utf8' },
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /annotated tag publication is not supported/u);
    assert.equal(existsSync(output), false);
  }));
