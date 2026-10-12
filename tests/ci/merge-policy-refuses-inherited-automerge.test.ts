// SPDX-License-Identifier: AGPL-3.0-only
//
// Nothing merges itself (ADR 0046). The merge-policy check refuses automatic
// merging written in renovate.json and automatic merging it would inherit: a
// preset such as `:automergePatch` turns it on for a whole category without
// the word `true` appearing anywhere in the file.

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const CHECKER = resolve(import.meta.dirname, '../../scripts/merge-policy-check.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'merge-policy-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The checker's exit code over a tree holding only `renovate`. */
function check(name: string, renovate: unknown): number | null {
  const tree = join(scratch, name);
  mkdirSync(join(tree, 'scripts'), { recursive: true });
  copyFileSync(CHECKER, join(tree, 'scripts/merge-policy-check.mjs'));
  writeFileSync(join(tree, 'renovate.json'), JSON.stringify(renovate));
  return spawnSync(process.execPath, [join(tree, 'scripts/merge-policy-check.mjs')]).status;
}

describe('the merge-policy check', () => {
  it('passes the presets this repository extends', () => {
    expect(check('ours', { extends: ['config:recommended', ':semanticCommits'] })).toBe(0);
  });

  it('refuses a preset that turns automatic merging on', () => {
    expect(check('inherited', { extends: ['config:recommended', ':automergePatch'] })).toBe(1);
  });

  it('refuses one inside a package rule too', () => {
    const rules = {
      packageRules: [{ matchDepTypes: ['devDependencies'], extends: [':automergeMinor'] }],
    };
    expect(check('rule', rules)).toBe(1);
  });

  it('refuses a preset it has not checked, whatever its name', () => {
    expect(check('unchecked', { extends: ['github>someone/presets'] })).toBe(1);
  });

  it('still refuses automerge written as true', () => {
    expect(check('literal', { packageRules: [{ automerge: true }] })).toBe(1);
  });
});
