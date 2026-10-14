// SPDX-License-Identifier: AGPL-3.0-only
// A commit this machine's gate has passed narrows a later first push only if
// everything that commit reaches was really scanned, by the rules that judge
// the later push. Each test passes a commit under a condition where part of its
// history was not scanned, then first-pushes a branch built on it to another
// remote, and expects the key in that unscanned history to be refused.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { branchHistorySelection } from '../../scripts/gate/public-branch.mjs';
import {
  firstPushFixture,
  installHook,
  scanned,
  source,
  tokenShaped,
} from './first-push-fixture.mjs';

const refused = (f, result, ref) => {
  assert.equal(
    result.status,
    1,
    `published the key; scanned ${scanned(result.output)}\n${result.output}`,
  );
  assert.equal(f.published('origin', ref), '');
};

test('a commit passed by its own weaker scanners does not cover its key for a push judged by stronger ones', (t) => {
  const f = firstPushFixture(t);
  assert.equal(f.push('origin', 'main').status, 0);

  // A branch whose scanners predate (or loosen) a rule: they pass anything.
  f.git('checkout', '-q', '-b', 'older-rules');
  f.commit('config.txt', `token = ${tokenShaped()}\n`, 'config');
  f.commit('scripts/public-content-check.mjs', 'process.exit(0);\n', 'content check');
  f.commit('scripts/gate/sweep.py', 'import sys\nsys.exit(0)\n', 'sweep');
  const weak = f.push('elsewhere', 'older-rules');
  assert.equal(weak.status, 0, weak.output);

  // Built on it with the current scanners back, first-pushed to origin.
  f.git('checkout', '-q', '-b', 'current-rules');
  f.git('checkout', 'main', '--', 'scripts');
  f.commit('notes.txt', 'current rules\n', 'current rules');
  refused(f, f.push('origin', 'current-rules'), 'current-rules');
});

test('a commit pushed with the scanners overridden does not cover its key for a later real push', (t) => {
  const f = firstPushFixture(t);
  f.git('checkout', '-q', '-b', 'wip');
  f.commit('config.txt', `token = ${tokenShaped()}\n`, 'config');
  // Both scanner commands replaced by `true` for one push to a scratch remote.
  const overridden = f.push('elsewhere', 'wip', { gate: 'true', publicContent: 'true' });
  assert.equal(overridden.status, 0, overridden.output);

  const tip = f.commit('notes.txt', 'later\n', 'later');
  const result = f.push('origin', 'wip');
  refused(f, result, 'wip');
  assert.deepEqual(scanned(result.output), [tip]);
});

test('a commit passed while a graft hid its parents does not cover them once the graft is gone', (t) => {
  const f = firstPushFixture(t);
  assert.equal(f.push('origin', 'main').status, 0);

  f.git('checkout', '-q', '-b', 'grafted');
  f.commit('config.txt', `token = ${tokenShaped()}\n`, 'config');
  f.commit('config.txt', null, 'drop config');
  const hidden = f.commit('notes.txt', 'grafted\n', 'notes');
  writeFileSync(join(f.repo, '.git/info/grafts'), `${hidden} ${f.base}\n`);
  const whileGrafted = f.push('elsewhere', 'grafted');
  assert.equal(whileGrafted.status, 1, whileGrafted.output);
  rmSync(join(f.repo, '.git/info/grafts'));

  f.commit('notes.txt', 'grafted\nlater\n', 'later');
  refused(f, f.push('origin', 'grafted'), 'grafted');
});

test('a failed baseline Git read falls back to full public history and refuses the old finding', (t) => {
  const f = firstPushFixture(t, { hooked: false });
  f.commit('inherited.txt', `https://${'pitch'}.example.invalid/fixture\n`, 'inherited note');
  f.git('push', '-q', 'origin', 'main');
  f.git('fetch', '-q', 'origin');
  installHook(f.repo);
  f.git('checkout', '-q', '-b', 'fresh');
  f.commit('fresh.txt', 'clean\n', 'fresh');
  const shim = join(f.scratch, 'shim');
  mkdirSync(shim);
  const actualGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const main = f.git('rev-parse', 'origin/main');
  const marker = join(f.scratch, 'failed-once');
  const script = [
    '#!/bin/sh',
    `case "$*" in *"ls-tree -rz --full-tree ${main}"*)`,
    `  if [ ! -e '${marker}' ]; then touch '${marker}'; exit 1; fi ;;`,
    'esac',
    `exec '${actualGit}' "$@"`,
    '',
  ].join('\n');
  writeFileSync(join(shim, 'git'), script);
  chmodSync(join(shim, 'git'), 0o755);
  const actualNode = execFileSync('which', ['node'], { encoding: 'utf8' }).trim();
  // Git prepends its helper directory to the hook's PATH. Restore the shim
  // for Node's Git reads so the failure occurs in the public checker.
  writeFileSync(
    join(shim, 'node'),
    `#!/bin/sh\nPATH='${shim}':"$PATH"\nexport PATH\nexec '${actualNode}' "$@"\n`,
  );
  chmodSync(join(shim, 'node'), 0o755);
  const result = f.push('origin', 'fresh', { env: { PATH: `${shim}:${process.env.PATH}` } });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /branch state could not be read; scanning full history/u);
  assert.match(result.output, /inherited.txt \[private-pitch-url\]/u);
});

test('a clean branch carrying the earlier public scanner can still be pushed', (t) => {
  const f = firstPushFixture(t, { hooked: false });
  const previousScanner = execFileSync(
    'git',
    [
      '-C',
      source,
      'show',
      'b0f662bb37d0274bb32c2bc14ba7f6dc2e7edd93:scripts/public-content-check.mjs',
    ],
    { encoding: 'utf8' },
  );
  f.commit('scripts/public-content-check.mjs', previousScanner + '\n', 'previous scanner');
  f.git('push', '-q', 'origin', 'main');
  f.git('fetch', '-q', 'origin');
  f.git('checkout', '-q', '-b', 'clean-older-branch');
  const tip = f.commit('fresh.txt', 'clean\n', 'clean change');
  installHook(f.repo);
  const result = f.push('origin', 'clean-older-branch');
  assert.equal(result.status, 0, result.output);
  assert.equal(f.published('origin', 'clean-older-branch'), tip);
});

test('the unreadable receipt check fails when permission denial is disabled', () => {
  // Change only the test's chmod operation. The scanners and hook are intact.
  // first-push-fixture clears NODE_OPTIONS before starting the hook.
  const loader = `import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const chmod = fs.chmodSync;
    fs.chmodSync = (path, mode) => {
      if (String(path).endsWith('/gate-public-passed') && mode === 0) {
        fs.readFileSync(path);
        console.error('control: receipt remains readable');
        return;
      }
      return chmod(path, mode);
    };
    syncBuiltinESMExports();`;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'data:text/javascript,' + encodeURIComponent(loader),
      '--test',
      '--test-name-pattern=^a public receipt with unreadable state',
      join(import.meta.dirname, 'pre-push-first-push-scans-unpassed-commits.test.mjs'),
    ],
    { encoding: 'utf8', timeout: 120000, env },
  );
  const output = result.stdout + result.stderr;
  assert.match(output, /a public receipt with unreadable state/u);
  assert.match(output, /control: receipt remains readable/u);
  assert.notEqual(
    result.status,
    0,
    'The unreadable-receipt claim still passes when chmod is skipped and the file is readable.\n' +
      output,
  );
});

const receiptRepository = (t, format) => {
  const repo = mkdtempSync(join(tmpdir(), 'public-receipts-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (args) => execFileSync('git', ['-C', repo, ...args]);
  git(['init', '-q', `--object-format=${format}`]);
  const commit = (message) => {
    git([
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=gate',
      '-c',
      'user.email=gate@example.invalid',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      message,
    ]);
    return git(['rev-parse', 'HEAD']).toString().trim();
  };
  const main = commit('baseline');
  git(['update-ref', 'refs/remotes/origin/main', main]);
  const tip = commit('branch');
  const fingerprint = 'a'.repeat(main.length);
  const row = `${tip} ${fingerprint}\n`;
  const receipt = join(repo, '.git', 'gate-public-passed');
  return { git, main, tip, fingerprint, row, receipt };
};

for (const format of ['sha1', 'sha256']) {
  test(`public receipts require complete hash pairs for ${format} repositories`, (t) => {
    const { git, main, tip, fingerprint, row, receipt } = receiptRepository(t, format);
    const cases = [
      ['empty', '', [main]],
      ['one pair', row, [main, tip]],
      ['duplicates', row + row, [main, tip]],
      ['final blank line', row + '\n', null],
      ['other fingerprint', `${tip} ${'b'.repeat(main.length)}\n`, [main]],
      ['short hash', `${tip.slice(1)} ${fingerprint}\n`, null],
      ['long hash', `${tip}a ${fingerprint}\n`, null],
      ['short fingerprint', `${tip} ${fingerprint.slice(1)}\n`, null],
      ['long fingerprint', `${tip} ${fingerprint}a\n`, null],
      ['uppercase', row.toUpperCase(), null],
      ['tab', row.replace(' ', '\t'), null],
      ['extra space', row.replace(' ', '  '), null],
      ['carriage return', row.replace('\n', '\r\n'), null],
      ['missing newline', row.trimEnd(), null],
      ['embedded blank line', row + '\n' + row, null],
      ['non-hex', row.replace(/^./u, 'g'), null],
      ['nul', row + '\0', null],
      ['unicode separator', row.replace(' ', '\u00A0'), null],
      ['quoted hash', `"${tip}" ${fingerprint}\n`, null],
      ['comment', row + '# comment\n', null],
      ['regexp syntax', `${tip} ${'.'.repeat(main.length)}\n`, null],
    ];
    for (const [name, text, bases] of cases) {
      writeFileSync(receipt, text);
      const result = branchHistorySelection(git, tip, { main, fingerprint });
      assert.deepEqual(result.selection, bases ? [tip, '--not', ...bases] : [tip], name);
      assert.equal(result.seen.size, 0, name);
    }
  });
}
