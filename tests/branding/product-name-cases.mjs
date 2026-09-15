// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const source = resolve(import.meta.dirname, '../..');
const targets = ['README.md', 'NOTICE'];

function fixture(t) {
  const temporary = mkdtempSync(join(tmpdir(), 'product-name-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const root = join(temporary, 'repository');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  copyFileSync(join(source, 'scripts/product-name.mjs'), join(root, 'scripts/product-name.mjs'));
  for (const file of targets) copyFileSync(join(source, file), join(root, file));
  const name = readFileSync(join(root, 'NOTICE'), 'utf8').split(/\r?\n/u)[0];
  writeFileSync(join(root, 'product.json'), JSON.stringify({ name }));
  return {
    root,
    temporary,
    run: (...args) =>
      spawnSync(process.execPath, [join(root, 'scripts/product-name.mjs'), ...args], {
        cwd: temporary,
        encoding: 'utf8',
        timeout: 10_000,
      }),
  };
}

function contents(root) {
  return targets.map((file) => readFileSync(join(root, file)));
}

test('the actual CLI renames two real headers, preserves their bodies, and is idempotent', (t) => {
  const { root, run } = fixture(t);
  const original = contents(root);
  const metadata = JSON.stringify({ name: 'Alternate Product' });
  writeFileSync(join(root, 'product.json'), metadata);

  assert.equal(run().status, 1, 'default mode reports stale headings');
  assert.deepEqual(contents(root), original, 'default mode leaves both files untouched');
  assert.equal(run('--check').status, 1, 'explicit check reports stale headings');
  assert.deepEqual(contents(root), original, 'check mode leaves both files untouched');
  const sync = run('--write');
  assert.equal(sync.status, 0, sync.stderr);
  const expected = original.map((bytes, index) =>
    Buffer.concat([
      Buffer.from(index === 0 ? '# Alternate Product' : 'Alternate Product'),
      bytes.subarray(bytes.indexOf(10)),
    ]),
  );
  assert.deepEqual(contents(root), expected, 'only the first line of each real file changes');
  assert.equal(run('--check').status, 0);
  assert.equal(run().status, 0);
  const modified = targets.map((file) => statSync(join(root, file), { bigint: true }).mtimeNs);
  assert.equal(run('--write').status, 0);
  assert.deepEqual(contents(root), expected, 'repeated sync preserves bytes');
  assert.deepEqual(
    targets.map((file) => statSync(join(root, file), { bigint: true }).mtimeNs),
    modified,
    'repeated sync does not rewrite unchanged files',
  );
  assert.equal(readFileSync(join(root, 'product.json'), 'utf8'), metadata);
});

test('invalid metadata and unknown arguments refuse writes', (t) => {
  const { root, run } = fixture(t);
  const original = contents(root);
  const invalid = [
    '{',
    'null',
    '[]',
    '"A name"',
    '{}',
    '{"name":42}',
    '{"name":"Valid Name","slug":"another-setting"}',
    ...[
      '',
      ' padded',
      'padded ',
      'two\nlines',
      'two\rlines',
      'two\twords',
      'two\u2028lines',
      'A\0name',
      '# Heading',
      '<b>Name</b>',
      '**Name**',
      '`Name`',
      '[Name](url)',
      'Name_italic',
      'Name &amp; Co',
    ].map((name) => JSON.stringify({ name })),
  ];
  for (const metadata of invalid) {
    writeFileSync(join(root, 'product.json'), metadata);
    const result = run('--write');
    assert.equal(result.status, 2, `metadata ${metadata}: ${result.stderr}`);
    assert.deepEqual(contents(root), original, 'invalid metadata preserves both files');
  }
  writeFileSync(join(root, 'product.json'), JSON.stringify({ name: 'Alternate Product' }));
  for (const args of [['--unknown'], ['--write', '--check'], ['--write', 'extra']]) {
    assert.equal(run(...args).status, 2);
    assert.deepEqual(contents(root), original, 'invalid arguments preserve both files');
  }
});

test('duplicate name members fail both modes even when the last name matches the real headings', (t) => {
  const { root, run } = fixture(t);
  const original = contents(root);
  const name = readFileSync(join(root, 'NOTICE'), 'utf8').split(/\r?\n/u)[0];
  const current = JSON.stringify(name);
  const different = JSON.stringify(name + ' Alternate');
  for (const metadata of [
    `{"name":${different},"name":${current}}`,
    `{"name":${current},"name":${current}}`,
  ]) {
    writeFileSync(join(root, 'product.json'), metadata);
    for (const mode of ['--check', '--write']) {
      const result = run(mode);
      assert.equal(result.status, 2, `${mode}: ${result.stderr}`);
      assert.deepEqual(contents(root), original, 'duplicate members preserve both files');
    }
  }

  const escaped = name
    .split('')
    .map((unit) => `\\u${unit.codePointAt(0).toString(16).padStart(4, '0')}`)
    .join('');
  writeFileSync(join(root, 'product.json'), ` \n {\n "name" \t: "${escaped}" \n }\n`);
  assert.equal(run('--check').status, 0, 'ordinary whitespace and Unicode escapes remain valid');
  assert.equal(run('--write').status, 0);
  assert.deepEqual(contents(root), original);
});

test('both targets are validated before the first write', (t) => {
  const { root, run } = fixture(t);
  writeFileSync(join(root, 'product.json'), JSON.stringify({ name: 'Alternate Product' }));
  writeFileSync(join(root, 'NOTICE'), '\nInvalid first line\n');
  const original = contents(root);
  assert.equal(run('--write').status, 2);
  assert.deepEqual(
    contents(root),
    original,
    'a later invalid target cannot leave a partial rename',
  );
  rmSync(join(root, 'NOTICE'));
  assert.equal(run('--write').status, 2);
  assert.deepEqual(readFileSync(join(root, 'README.md')), original[0]);
  mkdirSync(join(root, 'NOTICE'));
  assert.equal(run('--write').status, 2);
  assert.deepEqual(readFileSync(join(root, 'README.md')), original[0]);
});

for (const target of targets) {
  test(`a symlink ${target} is refused without modifying either target`, (t) => {
    const { root, temporary, run } = fixture(t);
    writeFileSync(join(root, 'product.json'), JSON.stringify({ name: 'Alternate Product' }));
    const outside = join(temporary, 'outside-file');
    copyFileSync(join(root, target), outside);
    rmSync(join(root, target));
    symlinkSync(outside, join(root, target));
    const original = contents(root);
    assert.equal(run('--check').status, 2);
    assert.equal(run('--write').status, 2);
    assert.deepEqual(contents(root), original, 'the linked file and other target remain untouched');
  });
}

test('sync preserves CRLF separators and non-UTF-8 bytes after the first line', (t) => {
  const { root, run } = fixture(t);
  const original = contents(root).map((bytes) =>
    Buffer.concat([
      bytes.subarray(0, bytes.indexOf(10)),
      Buffer.from('\r\n'),
      bytes.subarray(bytes.indexOf(10) + 1),
      Buffer.from([0xff, 0x00, 0xfe]),
    ]),
  );
  targets.forEach((file, index) => writeFileSync(join(root, file), original[index]));
  writeFileSync(join(root, 'product.json'), JSON.stringify({ name: 'Café Tools' }));
  assert.equal(run('--write').status, 0);
  assert.deepEqual(
    contents(root),
    original.map((bytes, index) =>
      Buffer.concat([
        Buffer.from(index === 0 ? '# Café Tools\r\n' : 'Café Tools\r\n'),
        bytes.subarray(bytes.indexOf(10) + 1),
      ]),
    ),
  );
  assert.equal(run('--check').status, 0);
});
