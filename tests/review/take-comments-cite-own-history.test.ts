// SPDX-License-Identifier: AGPL-3.0-only
//
// Opus interim review of SL13's take (75527ae..9c625d4), finding M1. Sits in
// tests/review/. 969fa33 cited a b0/SL11 commit in a test comment; that
// commit is not in this head's history, so the docs history guard
// (authority-proofs-and-history-docs 'resolve in the history of this head')
// is red. Closed by 4b45853 (outside the reviewed range).

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const FILES = ['tests/api/api-1-isolation-delegation.ts', 'tests/ci/upgrade-drill.test.ts'];

it("the take's own test comments cite only commits in this head's history", () => {
  const unreachable: string[] = [];
  for (const file of FILES) {
    const text = readFileSync(`${root}${file}`, 'utf8');
    for (const [hash] of text.matchAll(/\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,12}\b/gu)) {
      const known = spawnSync('git', ['cat-file', '-e', `${hash}^{commit}`], { cwd: root });
      if (known.status !== 0) continue;
      const reach = spawnSync('git', ['merge-base', '--is-ancestor', hash, 'HEAD'], { cwd: root });
      if (reach.status !== 0) unreachable.push(`${file}: ${hash}`);
    }
  }
  expect(unreachable).toEqual([]);
});
