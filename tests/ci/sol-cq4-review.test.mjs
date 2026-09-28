// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const bodyAfterImports = (source) => source.slice(source.indexOf('if (serverUrl === undefined)'));

test('Sol proof, criterion 6: production imports enter each package through its index', () => {
  for (const path of [
    'apps/cli/client.ts',
    'apps/cli/main.ts',
    'apps/web/src/operations/client.ts',
    'apps/web/src/records/submit.ts',
  ]) {
    assert.equal(
      /from\s*['"][^'"]*packages\/core-commands\/src\/(?!index\.ts)[^'"]+['"]/u.test(read(path)),
      false,
      `${path} reaches past the command package index`,
    );
  }
});

test('Sol proof, criterion 7: existing gate-expiry test body changes only at imports', () => {
  const path = 'tests/reads/gate-expiry.test.ts';
  const before = execFileSync('git', ['show', `cf802d63e6016133250a1a3b3515c0de35bcc123:${path}`], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(
    bodyAfterImports(read(path)) === bodyAfterImports(before),
    true,
    'the existing test body changed at its readFileSync source path, beyond import lines',
  );
});
