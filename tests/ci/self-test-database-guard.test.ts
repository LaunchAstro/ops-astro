// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, expect, it, vi } from 'vitest';

const original = { ...process.env };

afterEach(() => {
  process.env = { ...original };
  vi.doUnmock('node:child_process');
  vi.doUnmock('./self-test/mutations.ts');
  vi.resetModules();
});

it('the self-test refuses a shared admin URL before opening its scratch worktree', async () => {
  process.env['DATABASE_URL'] = 'postgres://postgres:x@127.0.0.1:54470/journey';
  process.env['DATABASE_ADMIN_URL'] = 'postgres://postgres:x@127.0.0.1:54390/journey';
  process.env['SELF_TEST_CLUSTER'] = 'self-test-container';
  process.env['SELF_TEST_PROOFS_PORT'] = '54471';
  process.env['SELF_TEST_PROOFS_API_PORT'] = '8871';
  process.env['DOCKER'] = '/fake/docker';

  vi.doMock('node:child_process', async () => ({
    ...(await vi.importActual<typeof import('node:child_process')>('node:child_process')),
    spawnSync: () => ({ status: 0, stdout: '0.0.0.0:54470\n', stderr: '' }),
  }));
  let scratchEntered = false;
  vi.doMock('./self-test/mutations.ts', async () => ({
    ...(await vi.importActual<typeof import('./self-test/mutations.ts')>(
      './self-test/mutations.ts',
    )),
    openScratch: () => {
      scratchEntered = true;
      throw new Error('scratch entered before the admin URL was refused');
    },
  }));

  let refusal = '';
  try {
    await import('./self-test/run.ts');
  } catch (error) {
    refusal = String(error);
  }
  expect(scratchEntered).toBe(false);
  expect(refusal).toMatch(/DATABASE_ADMIN_URL.*refused/u);
});
