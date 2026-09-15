// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const checker = resolve(import.meta.dirname, '../../scripts/spdx-check.mjs');
const header = '// SPDX-License-Identifier: AGPL-3.0-only\n';

test('source header check covers tracked, untracked and hook files without relicensing vendored code', () => {
  const root = mkdtempSync(join(tmpdir(), 'foundation-spdx-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    mkdirSync(join(root, 'scripts'));
    const source = join(root, 'scripts/run.mjs');
    writeFileSync(source, 'export const value = 1;\n');
    execFileSync('git', ['-C', root, 'add', '.']);
    const check = () => spawnSync(process.execPath, [checker, root], { encoding: 'utf8' }).status;
    assert.equal(check(), 1, 'tracked source without a header fails');
    writeFileSync(source, header + 'export const value = 1;\n');
    assert.equal(check(), 0, 'correct header passes');
    writeFileSync(source, header.replace('AGPL-3.0-only', 'Apache-2.0'));
    assert.equal(check(), 1, 'incorrect licence identifier fails');
    writeFileSync(source, header + header);
    assert.equal(check(), 1, 'duplicate headers fail');
    writeFileSync(source, header);
    writeFileSync(join(root, 'new.ts'), 'export const value = 1;\n');
    assert.equal(check(), 1, 'new untracked source is checked');
    rmSync(join(root, 'new.ts'));
    mkdirSync(join(root, '.husky'));
    const hook = join(root, '.husky/commit-msg');
    writeFileSync(hook, '#!/bin/sh\nexit 0\n');
    assert.equal(check(), 1, 'extensionless hook is checked');
    writeFileSync(hook, '#!/bin/sh\n# SPDX-License-Identifier: AGPL-3.0-only\nexit 0\n');
    assert.equal(check(), 0, 'shebang stays first');
    mkdirSync(join(root, '.claude/skills/vendor'), { recursive: true });
    writeFileSync(
      join(root, '.claude/skills/vendor/upstream.mjs'),
      '// SPDX-License-Identifier: MIT\n',
    );
    assert.equal(check(), 0, 'vendored licence stays unchanged');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
