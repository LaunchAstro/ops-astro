// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('Sol proof, criterion 7: the hidden inbox isolation test must reject an injected hidden-item resync', () => {
  const folder = mkdtempSync(resolve('tests/api/.sol-ow002-faithfulness-'));
  try {
    const setup = resolve(folder, 'mutation.ts');
    writeFileSync(
      setup,
      `
import { vi } from 'vitest';
vi.mock(${JSON.stringify(resolve('apps/api/live-board.ts'))}, async (original) => {
  const real = await original();
  return { ...real, followBoard: (stream, topics, on, ask) => real.followBoard(stream, {
    ...topics,
    subscribeBoard: (business, person, send, stop) => topics.subscribeBoard(business, person, (signal) => {
      if (signal.kind === 'inbox') {
        console.log('SOL MUTATION: spurious hidden-inbox resync injected');
        void stream.writeSSE({ event: 'resync', data: '' });
      }
      send(signal);
    }, stop),
  }, on, ask) };
});
`,
    );
    const config = resolve(folder, 'config.mjs');
    writeFileSync(
      config,
      `export default { test: {
      environment: 'node',
      include: ['tests/api/live-board-task-resync-isolation-review.test.ts'],
      setupFiles: [${JSON.stringify(setup)}], maxWorkers: 1,
    } };
`,
    );
    const child = spawnSync(
      process.execPath,
      [resolve('node_modules/vitest/vitest.mjs'), 'run', '--config', config],
      { encoding: 'utf8', timeout: 30_000, env: { ...process.env, TMPDIR: folder } },
    );
    const output = child.stdout + child.stderr;
    expect(output, 'the mutant actually ran').toContain(
      'SOL MUTATION: spurious hidden-inbox resync injected',
    );
    expect(
      child.status,
      `${output}\nBoth original tests passed despite the hidden inbox causing a resync; the isolation assertion checks only the obsolete inbox event.`,
    ).not.toBe(0);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
