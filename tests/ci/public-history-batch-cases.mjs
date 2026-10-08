// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  ceiling,
  historyFixture,
  scanPublicFiles,
  typedHistory,
} from './history-batch-fixture.mjs';

const prohibited = ['synthetic', 'public', 'client'].join('');
const identity = ['7654321+fixture', '@', 'users.noreply.github.com'].join('');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function seedMixedHistory(repo, source) {
  const bytes = Buffer.from(`first\n${prohibited}\nlast\n\n`);
  for (const path of ['first.md', 'second.md', `${prohibited}.md`, 'tab\tline\n.md'])
    writeFileSync(join(repo, path), bytes);
  writeFileSync(join(repo, 'empty.txt'), Buffer.alloc(0));
  writeFileSync(join(repo, 'invalid.txt'), Buffer.from([0xff, 10]));
  writeFileSync(join(repo, 'nul.txt'), Buffer.from([65, 0, 66, 10]));
  writeFileSync(join(repo, 'executable.sh'), 'echo neutral\n');
  chmodSync(join(repo, 'executable.sh'), 0o755);
  symlinkSync('first.md', join(repo, 'link'));
  mkdirSync(join(repo, 'tests/gate'), { recursive: true });
  const shapes = readFileSync(join(source, 'tests/gate/shape-canary.txt'));
  writeFileSync(join(repo, 'tests/gate/shape-canary.txt'), shapes);
  writeFileSync(join(repo, 'copied-shapes.txt'), shapes);
}

test('history batches preserve every ordered raw entry, scope, path pair and policy finding', () =>
  historyFixture(({ dir, repo, git, text, commit, root, source, history }) => {
    seedMixedHistory(repo, source);
    commit();
    const raw = Buffer.from(
      `tree ${text('rev-parse', 'HEAD^{tree}')}\nparent ${root}\nauthor Fixture <fixture@example.invalid> 1700000000 +0000\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\ngpgsig fixture-line-one\n fixture-line-two\n\nchore: raw headers\n\nAn independent body.\n\nCo-authored-by: Fixture <${identity}>\nAssisted-by: LLM\n`,
    );
    const rawPath = join(dir, 'raw-commit');
    writeFileSync(rawPath, raw);
    text('update-ref', 'refs/heads/main', text('hash-object', '-t', 'commit', '-w', rawPath));
    rmSync(join(repo, 'first.md'));
    rmSync(join(repo, 'second.md'));
    commit();
    const expected = typedHistory(git);
    const actual = history();
    assert.deepEqual(actual, expected);
    assert.deepEqual(scanPublicFiles(actual.files), scanPublicFiles(expected.files));
    const findings = scanPublicFiles(actual.files);
    assert.ok(
      findings.some(
        (finding) => finding.file === '<withheld-path>' && finding.rule === 'excluded-token',
      ),
    );
    assert.ok(
      findings.some(
        (finding) => finding.file === 'invalid.txt' && finding.rule === 'non-text-foundation-file',
      ),
    );
    assert.ok(
      findings.some(
        (finding) => finding.file === 'nul.txt' && finding.rule === 'non-text-foundation-file',
      ),
    );
    assert.ok(
      findings.some(
        (finding) => finding.file === 'copied-shapes.txt' && finding.rule === 'personal-path',
      ),
    );
    assert.ok(
      !findings.some(
        (finding) =>
          finding.file === 'tests/gate/shape-canary.txt' && finding.rule === 'personal-path',
      ),
    );
    assert.ok(actual.files.some((entry) => entry.scope === 'commit' && entry.bytes.equals(raw)));
  }));

test('replacement refs cannot hide prohibited raw commit or blob bytes', () =>
  historyFixture(({ repo, git, text, commit, root, history }) => {
    writeFileSync(join(repo, 'removed.md'), prohibited);
    const bad = commit(`chore: ${prohibited}`);
    const oldBlob = text('rev-parse', `${bad}:removed.md`);
    writeFileSync(join(repo, 'removed.md'), 'neutral replacement');
    const tip = commit();
    text('replace', bad, root);
    text('replace', oldBlob, text('rev-parse', `${tip}:removed.md`));
    const expected = typedHistory(git);
    const actual = history();
    assert.deepEqual(actual, expected);
    assert.deepEqual(scanPublicFiles(actual.files), scanPublicFiles(expected.files));
    assert.ok(
      scanPublicFiles(actual.files).filter((finding) => finding.rule === 'excluded-token').length >=
        2,
    );
  }));

test('unsupported gitlinks still refuse the complete history', () =>
  historyFixture(({ text, root, commit, history }) => {
    text('update-index', '--add', '--cacheinfo', `160000,${root},vendor`);
    text('commit', '-qm', 'chore: unsupported entry fixture');
    commit();
    assert.throws(() => history(), /unsupported entry/u);
  }));

test('missing historical objects refuse without leaking Git stderr', () =>
  historyFixture(({ repo, text, commit, cli }) => {
    writeFileSync(join(repo, 'lost.md'), 'ordinary unique bytes');
    const oid = text('hash-object', '-w', join(repo, 'lost.md'));
    commit();
    rmSync(join(repo, '.git/objects', oid.slice(0, 2), oid.slice(2)));
    const result = cli();
    assert.equal(result.status, 1);
    assert.ok(!result.stderr.includes(oid));
    assert.doesNotMatch(result.stderr, /fatal:|error:/u);
  }));

for (const fault of [
  'check-oid',
  'check-size',
  'check-type',
  'check-missing',
  'check-extra',
  'check-failure',
  'batch-oid',
  'batch-type',
  'batch-size',
  'batch-truncated',
  'batch-delimiter',
  'batch-missing',
  'batch-extra',
  'batch-failure',
]) {
  test(`history acquisition refuses ${fault} instead of a partial successful scan`, () =>
    historyFixture(({ cli }) => {
      const result = cli(fault);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.ok(!result.stderr.includes('planted-private-marker'));
      assert.doesNotMatch(result.stderr, /fatal:|error:/u);
    }));
}

test('an unexpected checked type retains the original typed cat-file fallback', () =>
  historyFixture(({ repo, commit, git, history, calls }) => {
    writeFileSync(join(repo, 'ordinary.txt'), 'ordinary contents');
    commit();
    assert.deepEqual(history('typed-fallback'), typedHistory(git));
    assert.ok(calls().some((args) => args.at(-3) === 'cat-file' && args.at(-2) === 'commit'));
    assert.ok(calls().some((args) => args.at(-3) === 'cat-file' && args.at(-2) === 'blob'));
  }));

test('a real tag object in a blob tree slot retains Git typed dereferencing', () =>
  historyFixture(({ dir, text, root, git, history, calls }) => {
    const payload = join(dir, 'payload');
    writeFileSync(payload, 'raw annotated blob payload\n');
    const blob = text('hash-object', '-w', payload);
    const tagged = join(dir, 'tag-object');
    writeFileSync(
      tagged,
      `object ${blob}\ntype blob\ntag fixture\ntagger Fixture <fixture@example.invalid> 1700000000 +0000\n\nA neutral object.\n`,
    );
    const tag = text('hash-object', '-t', 'tag', '-w', tagged);
    const treeFile = join(dir, 'tree-object');
    writeFileSync(
      treeFile,
      Buffer.concat([Buffer.from('100644 tagged.txt\0'), Buffer.from(tag, 'hex')]),
    );
    const tree = text('hash-object', '-t', 'tree', '-w', treeFile);
    const commitFile = join(dir, 'commit-object');
    writeFileSync(
      commitFile,
      `tree ${tree}\nparent ${root}\nauthor Fixture <fixture@example.invalid> 1700000000 +0000\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\n\nchore: typed object fixture\n`,
    );
    text('update-ref', 'refs/heads/main', text('hash-object', '-t', 'commit', '-w', commitFile));
    const actual = history();
    assert.deepEqual(actual, typedHistory(git));
    assert.equal(
      actual.files.find((file) => file.path === 'tagged.txt').bytes.toString(),
      'raw annotated blob payload\n',
    );
    assert.ok(
      calls().some(
        (args) => args.at(-3) === 'cat-file' && args.at(-2) === 'blob' && args.at(-1) === tag,
      ),
    );
  }));

test('many empty commits retain every metadata object and tree walk with bounded Git invocations', () =>
  historyFixture(({ commit, git, history, calls }) => {
    for (let i = 0; i < 256; i++) commit(`chore: empty fixture ${i}`);
    const actual = history();
    assert.deepEqual(actual, typedHistory(git));
    assert.equal(actual.commits, 257);
    assert.equal(calls().filter((args) => args.includes('ls-tree')).length, actual.commits);
    console.log(
      JSON.stringify({
        fixture: 'empty-history',
        commits: actual.commits,
        gitInvocations: calls().length,
        treeCalls: calls().filter((args) => args.includes('ls-tree')).length,
        sizeQueries: calls().filter((args) => args.includes('--batch-check')).length,
        contentBatches: calls().filter((args) => args.includes('--batch')).length,
      }),
    );
    assert.ok(calls().filter((args) => args.includes('--batch-check')).length > 1);
    assert.ok(
      calls().length <= actual.commits + 10,
      `Git invocations ${calls().length} for ${actual.commits} commits`,
    );
  }));

test('large object batches split transport without omitting any requested bytes', () =>
  historyFixture(({ repo, commit, history, calls }) => {
    const size = 34 * 1024 * 1024;
    writeFileSync(join(repo, 'first.bin'), Buffer.alloc(size, 0));
    writeFileSync(join(repo, 'second.bin'), Buffer.alloc(size, 255));
    commit();
    const actual = history();
    assert.equal(actual.blobPaths, 2);
    for (const [path, byte] of [
      ['first.bin', 0],
      ['second.bin', 255],
    ]) {
      const entry = actual.files.find((file) => file.path === path);
      assert.equal(entry.bytes.length, size);
      assert.equal(digest(entry.bytes), digest(Buffer.alloc(size, byte)));
    }
    assert.equal(calls().filter((args) => args.includes('--batch')).length, 3);
  }));

test('an exactly ceiling-sized batch frame remains byte-exact', () =>
  historyFixture(({ repo, commit, git, history, calls }) => {
    const size = ceiling - Buffer.byteLength(`${'0'.repeat(40)} blob ${ceiling}\n`) - 1;
    writeFileSync(join(repo, 'boundary.bin'), Buffer.alloc(size, 1));
    commit();
    const actual = history();
    const expected = git(
      'cat-file',
      'blob',
      git('rev-parse', 'HEAD:boundary.bin').toString().trim(),
    );
    assert.equal(
      digest(actual.files.find((file) => file.path === 'boundary.bin').bytes),
      digest(expected),
    );
    assert.ok(!calls().some((args) => args.at(-3) === 'cat-file' && args.at(-2) === 'blob'));
  }));

test('a payload within the legacy ceiling but beyond batch framing uses typed fallback', () =>
  historyFixture(({ repo, commit, history, calls }) => {
    writeFileSync(join(repo, 'singleton.bin'), Buffer.alloc(ceiling, 2));
    commit();
    const actual = history();
    const entry = actual.files.find((file) => file.path === 'singleton.bin');
    assert.equal(entry.bytes.length, ceiling);
    assert.equal(digest(entry.bytes), digest(Buffer.alloc(ceiling, 2)));
    assert.ok(calls().some((args) => args.at(-3) === 'cat-file' && args.at(-2) === 'blob'));
  }));

test('an object over the legacy ceiling still refuses rather than trimming coverage', () =>
  historyFixture(({ repo, commit, cli }) => {
    writeFileSync(join(repo, 'oversize.bin'), Buffer.alloc(ceiling + 1, 3));
    commit();
    const result = cli();
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /fatal:|error:/u);
  }));
