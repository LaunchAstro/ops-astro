// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, expect, it, vi } from 'vitest';

const original = { ...process.env };

afterEach(() => {
  process.env = { ...original };
  vi.doUnmock('node:child_process');
  vi.doUnmock('./self-test/mutations.ts');
  vi.doUnmock('./self-test/vitest-report.ts');
  vi.resetModules();
  vi.restoreAllMocks();
});

it('a failed unmutated typecheck makes its control red', async () => {
  process.env['DATABASE_URL'] = 'postgres://postgres:x@127.0.0.1:54470/journey';
  process.env['DATABASE_ADMIN_URL'] = process.env['DATABASE_URL'];
  process.env['SELF_TEST_CLUSTER'] = 'self-test-container';
  process.env['SELF_TEST_PROOFS_PORT'] = '54471';
  process.env['SELF_TEST_PROOFS_API_PORT'] = '8871';
  process.env['SELF_TEST_ONLY'] = 'T2a';
  process.env['DOCKER'] = '/fake/docker';

  vi.doMock('node:child_process', async () => ({
    ...(await vi.importActual<typeof import('node:child_process')>('node:child_process')),
    spawnSync: (command: string) => {
      if (command === '/fake/docker') return { status: 0, stdout: '0.0.0.0:54470\n', stderr: '' };
      if (command.includes('/tsc')) {
        return {
          status: 1,
          stdout: 'apps/web/src/other.ts(1,1): error TS9999: baseline error\n',
          stderr: '',
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  }));
  vi.doMock('./self-test/mutations.ts', async () => ({
    ...(await vi.importActual<typeof import('./self-test/mutations.ts')>(
      './self-test/mutations.ts',
    )),
    openScratch: () => ({ dir: '/tmp/sol-t4e-no-files', reset: () => {}, close: () => {} }),
    deleteOneMigration: () => {
      throw new Error('stop after controls');
    },
  }));
  vi.doMock('./self-test/vitest-report.ts', () => ({
    vitestReport: () => ({}),
    summarise: () => ({ applied: true, executed: 1, red: false, detail: 'green' }),
  }));
  const output: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => {
    output.push(line);
  });

  await import('./self-test/run.ts');
  const typecheck = output
    .filter((line) => line.startsWith('journey-case '))
    .map(
      (line) => JSON.parse(line.slice('journey-case '.length)) as { case: string; status: string },
    )
    .find((line) => line.case === 'control: the typecheck');
  expect(typecheck?.status).toBe('fail');
});
