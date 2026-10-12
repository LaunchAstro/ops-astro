// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-04: a deployment may name `/` as its instruction root. A plain file
// beneath it, reached through plain directories, reads as it would under any
// other root.

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { directorySource } from '../../packages/core-runtime/src/instruction-root.ts';

const folder = realpathSync(mkdtempSync(join(tmpdir(), 'instruction-at-root-')));
afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

it('a root of / reads a plain file beneath it', async () => {
  writeFileSync(join(folder, 'entry.md'), 'beneath the root');
  const read = await directorySource('/').read(`${folder.slice(1)}/entry.md`);
  expect(read === undefined ? undefined : new TextDecoder().decode(read)).toBe('beneath the root');
});
