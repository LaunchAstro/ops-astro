// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-04: the instruction root's checks look at every segment without following
// links, then open the file. A directory on the way swapped for a link to
// somewhere outside the root after those checks, and swapped back once the
// file is open, must not hand over the outside file's bytes: what was opened
// is judged again against the path inside the root. Only the timing of the
// swap is the test's, around the real `open`.

import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { directorySource } from '../../packages/core-runtime/src/instruction-root.ts';

const swap = vi.hoisted(() => ({ before: (): void => undefined, after: (): void => undefined }));

vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>();
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      swap.before();
      try {
        return await real.open(...args);
      } finally {
        swap.after();
      }
    },
  };
});

const outside = mkdtempSync(join(tmpdir(), 'instruction-outside-'));
const root = mkdtempSync(join(tmpdir(), 'instruction-root-'));
afterAll(() => {
  rmSync(outside, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

it('a directory swapped for a link to outside the root while the file opens reads as nothing', async () => {
  mkdirSync(join(root, 'skills'));
  writeFileSync(join(root, 'skills', 'brief.md'), 'inside');
  writeFileSync(join(outside, 'brief.md'), 'planted outside the root');
  const skills = join(root, 'skills');
  const kept = join(root, 'skills-kept');
  swap.before = () => {
    swap.before = () => undefined;
    renameSync(skills, kept);
    symlinkSync(outside, skills);
  };
  swap.after = () => {
    swap.after = () => undefined;
    rmSync(skills);
    renameSync(kept, skills);
  };

  const read = await directorySource(root).read('skills/brief.md');

  expect(read === undefined ? undefined : new TextDecoder().decode(read)).toBeUndefined();
  // Once nothing moves, the same path reads its own file.
  expect(new TextDecoder().decode(await directorySource(root).read('skills/brief.md'))).toBe(
    'inside',
  );
});
