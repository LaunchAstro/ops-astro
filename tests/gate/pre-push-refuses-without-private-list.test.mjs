// SPDX-License-Identifier: AGPL-3.0-only
// The literal sweep needs the private clear-text list, which lives outside
// git. A push on a machine without it is refused, loudly, naming the setting
// that supplies it; it never goes out with that step skipped. Each case runs
// the real hook and the real scanners in a throwaway repository.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const source = resolve(import.meta.dirname, '../..');
const hook = process.env.SOL_REVIEW_HOOK || join(source, '.husky/pre-push');

// A made-up term, built at run time so no committed file holds it.
const term = () => `zq${randomBytes(6).toString('hex')}`;

function repository(t) {
  const repo = mkdtempSync(join(tmpdir(), 'private-list-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Gate Test');
  git('config', 'user.email', 'gate@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  for (const dir of ['scripts', 'tests/gate']) mkdirSync(join(repo, dir), { recursive: true });
  cpSync(join(source, 'scripts/gate'), join(repo, 'scripts/gate'), { recursive: true });
  for (const name of ['canary.txt', 'shape-canary.txt'])
    copyFileSync(join(source, 'tests/gate', name), join(repo, 'tests/gate', name));
  git('add', '.');
  git('commit', '-qm', 'scanners');
  const commit = (file, text) => {
    writeFileSync(join(repo, file), text);
    git('add', file);
    git('commit', '-qm', file);
    return git('rev-parse', 'HEAD');
  };
  // The list sits outside the repository, as on a maintainer machine.
  const list = (terms) => {
    const path = join(mkdtempSync(join(tmpdir(), 'private-list-terms-')), 'terms.txt');
    t.after(() => rmSync(resolve(path, '..'), { recursive: true, force: true }));
    writeFileSync(path, `${terms.join('\n')}\n`);
    return path;
  };
  const push = (sha, terms) => {
    const env = { ...process.env, HUB_PUBLIC_CONTENT_CMD: 'true' };
    for (const name of ['HUB_GATE_CMD', 'HUB_GATE_TERMS', 'HUB_GATE_LITERAL_HISTORY_RECEIPT'])
      delete env[name];
    if (terms !== undefined) env.HUB_GATE_TERMS = terms;
    const result = spawnSync('sh', ['-e', hook], {
      cwd: repo,
      env,
      encoding: 'utf8',
      input: `refs/heads/main ${sha} refs/heads/main ${'0'.repeat(40)}\n`,
    });
    return { status: result.status, output: result.stdout + result.stderr };
  };
  return { commit, list, push };
}

test('a push with no private list set is refused, naming the setting', (t) => {
  const r = repository(t);
  const sha = r.commit('notes.txt', 'clean notes\n');
  const result = r.push(sha);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /HUB_GATE_TERMS/u);
  assert.match(result.output, /Refusing the push/u);
});

test('a push whose private list setting names no file is refused without printing the path', (t) => {
  const r = repository(t);
  const sha = r.commit('notes.txt', 'clean notes\n');
  const missing = join(tmpdir(), `private-list-absent-${randomBytes(6).toString('hex')}.txt`);
  const result = r.push(sha, missing);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /HUB_GATE_TERMS/u);
  assert.doesNotMatch(result.output, new RegExp(missing.replaceAll('.', '\\.'), 'u'));
});

test('a clean push with the private list present passes, and the literal sweep runs', (t) => {
  const r = repository(t);
  const sha = r.commit('notes.txt', 'clean notes\n');
  const listed = term();
  const result = r.push(sha, r.list([listed]));
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /gate: clean \(literal, /u);
  assert.doesNotMatch(result.output, new RegExp(listed, 'u'));
});

test('a push carrying a listed term is refused without printing the term', (t) => {
  const r = repository(t);
  const listed = term();
  const sha = r.commit('notes.txt', `a note about ${listed}\n`);
  const result = r.push(sha, r.list([listed]));
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /literal sweep found contamination/u);
  assert.doesNotMatch(result.output, new RegExp(listed, 'u'));
});
