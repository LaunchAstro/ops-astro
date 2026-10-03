// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { READ_NAMES } from '../../apps/web/src/operations/read-names.ts';
import { MADE_UP_READS } from '../visual/made-up-api.ts';

it('Sol proof, criterion 7: the parity gate reaches the grant check for both map reads', () => {
  const result = spawnSync(process.execPath, ['scripts/command-parity.mjs', '--check'], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  const missing = result.stdout.split('Missing or unequal:')[1]?.split('Exempt, view only:')[0];
  expect(result.status, missing ?? result.stderr).toBe(0);
}, 65_000);

it('Sol proof, criterion 7: the visual read inventory accounts for both new map reads', () => {
  const source = readFileSync('tests/visual/made-up-api.test.ts', 'utf8');
  const declaration = /const NOT_DRAWN = new Set\(\[([\s\S]*?)\]\);/u.exec(source)?.[1];
  expect(declaration).toBeDefined();
  const notDrawn = new Set(
    [...String(declaration).matchAll(/'([^']+)'/gu)].map((match) => match[1]),
  );
  const missing = READ_NAMES.filter((name) => !notDrawn.has(name) && !MADE_UP_READS.includes(name));
  expect(missing).toStrictEqual([]);
});
