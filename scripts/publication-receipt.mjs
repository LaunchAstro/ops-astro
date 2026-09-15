// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync, spawnSync } from 'node:child_process';
import { realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { externalOutput, options } from './candidate-snapshot.mjs';

try {
  const argumentsList = process.argv.slice(2);
  const firstRoot = argumentsList.shift() === '--first-root';
  const opts = options(argumentsList, ['ref', 'output']);
  if (!firstRoot || !opts.ref || !opts.output) {
    throw new Error('usage: publication-receipt.sh --first-root --ref REF --output EXTERNAL_MD');
  }
  const repo = realpathSync(resolve(import.meta.dirname, '..'));
  const output = externalOutput(opts.output, [repo]);
  const git = (args) =>
    execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  const sha = git(['rev-parse', '--verify', '--end-of-options', `${opts.ref}^{object}`]);
  if (git(['cat-file', '-t', sha]) !== 'commit') {
    throw new Error('receipt requires a commit object; annotated tag publication is not supported');
  }
  const commits = git(['rev-list', sha]).split('\n');
  const results = [];
  const record = (label, pass) => results.push({ label, status: pass ? 'PASS' : 'FAIL' });
  record('Proposed history is exactly one new root commit', commits.length === 1);
  record('Checkout HEAD equals the proposed commit', git(['rev-parse', 'HEAD']) === sha);
  record(
    'Checkout has no uncommitted or nonignored untracked files',
    git(['status', '--porcelain', '--untracked-files=all']) === '',
  );
  const initialPass = results.every(({ status }) => status === 'PASS');
  if (initialPass) {
    const run = (label, command, args, env = {}) => {
      const result = spawnSync(command, args, {
        cwd: repo,
        env: { ...process.env, ...env },
        stdio: 'ignore',
      });
      record(label, result.status === 0);
    };
    run('Commit signature verifies locally using current trust configuration', 'git', [
      'verify-commit',
      sha,
    ]);
    run('Contamination scanner self-test', 'python3', ['scripts/gate/sweep.py', '--self-test']);
    run('Contamination scan of all proposed history', 'python3', [
      'scripts/gate/sweep.py',
      '--range',
      sha,
    ]);
    run(
      'Root commit subject and provenance declarations',
      process.execPath,
      ['scripts/commit-range-check.mjs'],
      { BASE_SHA: sha, HEAD_SHA: sha, HUB_RANGE_INCLUDE_ROOT: '1', CI: 'true' },
    );
    run(
      'Public foundation content policy on every proposed commit, metadata and blob/path',
      process.execPath,
      ['scripts/public-content-check.mjs', '--repo', repo, '--range', sha],
    );
    run('Secret scan of the proposed history', 'gitleaks', [
      'git',
      '--no-banner',
      '--redact',
      '--config',
      '.gitleaks.toml',
      `--log-opts=${sha}`,
      '.',
    ]);
  }
  const pass = results.every(({ status }) => status === 'PASS');
  const lines = [
    '# Local first-publication commit receipt',
    '',
    `Proposed commit: \`${sha}\`. Reachable commits: ${commits.length}.`,
    '',
    'This receipt records local checks of an explicit committed candidate. File-only preparation uses the separate candidate manifest. Inherited source history is not a first-root publication candidate.',
    '',
    ...results.map(({ label, status }) => `- ${status}: ${label}.`),
    ...(initialPass
      ? []
      : [
          '- NOT RUN: signature, content, provenance and secret checks. The candidate prerequisites failed.',
        ]),
    '',
    'Hosted workflows, required check names and app origins, Copilot review, branch enforcement, GitHub signature display and mailbox delivery were not verified by this command. It makes no claim about their current state.',
    '',
    'Model/tool trailers are declarations. This command cannot establish who typed a sign-off or verify the actual authoring model. Product behaviour and publication approval are outside its scope.',
    '',
    `Local result: ${pass ? 'PASS' : 'FAIL'}. Publication still requires the owner decision and separately recorded hosted evidence.`,
    '',
  ];
  writeFileSync(output, lines.join('\n'), { flag: 'wx' });
  console.log(`receipt: ${pass ? 'PASS' : 'FAIL'}, external local-evidence file written`);
  process.exitCode = pass ? 0 : 1;
} catch (error) {
  console.error(
    `receipt: ${error.code || error.status !== undefined ? 'file or Git operation failed' : error.message}`,
  );
  process.exitCode = 2;
}
