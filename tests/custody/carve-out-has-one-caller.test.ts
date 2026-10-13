// SPDX-License-Identifier: AGPL-3.0-only
//
// The paid chat's carve-out (`carriesOutside`) is asked from one place only,
// the conversation seam's held path, so free text can reach the outside paid
// route by no other door. Its provider and operation names, written out in
// custody's own file, are core-connectors' own.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';
import {
  OPENROUTER_CONVERSATION_KEY,
  OPENROUTER_PROVIDER,
} from '../../packages/core-connectors/src/index.ts';
import {
  OUTSIDE_OPERATION,
  OUTSIDE_PROVIDER,
} from '../../packages/core-custody/src/outside-carriage.ts';

const ROOT = join(import.meta.dirname, '..', '..');

function sources(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    if (name === 'node_modules' || name === 'dist') return [];
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx|mts)$/u.test(name) ? [path] : [];
  });
}

it('carriesOutside is called only from the held path', () => {
  const callers = [...sources(join(ROOT, 'packages')), ...sources(join(ROOT, 'apps'))]
    .filter((path) => /\bcarriesOutside\s*\(/u.test(readFileSync(path, 'utf8')))
    .map((path) => relative(ROOT, path))
    .toSorted();
  expect(callers).toStrictEqual([
    'packages/core-custody/src/broker-priced.ts',
    'packages/core-custody/src/outside-carriage.ts',
  ]);
  const definition = readFileSync(
    join(ROOT, 'packages/core-custody/src/outside-carriage.ts'),
    'utf8',
  );
  expect(definition.match(/\bcarriesOutside\s*\(/gu)).toHaveLength(1);
});

it("custody's outside names are core-connectors' own", () => {
  expect(OUTSIDE_PROVIDER).toBe(OPENROUTER_PROVIDER);
  expect(OUTSIDE_OPERATION).toBe(OPENROUTER_CONVERSATION_KEY);
});
