// SPDX-License-Identifier: AGPL-3.0-only
//
// A run stopped before docker has written its container's id (a deadline
// during create) still removes its container: by the run's own name, once the
// client has closed, and its folder goes too. The stand-in docker opens the id
// file empty, as docker does before it asks for the container, never writes
// the id, and records each removal it is asked for.

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const bin = mkdtempSync(join(tmpdir(), 'container-run-'));
const calls = join(bin, 'calls');
afterAll(() => rmSync(bin, { recursive: true, force: true }));

it('a run stopped during create removes its container by its own name', async () => {
  writeFileSync(calls, '');
  writeFileSync(
    join(bin, 'docker'),
    [
      '#!/bin/sh',
      `if [ "$1" = rm ]; then echo "$*" >> "${calls}"; exit 0; fi`,
      'for arg in "$@"; do case $arg in --cidfile=*) : > "${arg#--cidfile=}" ;; esac; done',
      "trap 'kill $child; exit 143' TERM",
      '/bin/sleep 5 & child=$!',
      'wait $child',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'docker'), 0o755);
  const path = process.env['PATH'];
  process.env['PATH'] = `${bin}:${path ?? ''}`;
  try {
    const module = '../../scripts/ops/container-run.mjs';
    const { runContainer } = (await import(
      /* @vite-ignore */
      module
    )) as {
      runContainer: (
        role: string,
        network: string,
        env: Record<string, string>,
        command: string[],
      ) => { child: { spawnargs: string[] }; stop: () => Promise<void> };
    };
    const run = runContainer('store', 'none', { PGHOST: 'backups' }, ['psql']);
    const name = run.child.spawnargs.find((arg) => arg.startsWith('--name='))?.slice(7);
    const folder = run.child.spawnargs.find((arg) => arg.startsWith('--cidfile='))?.slice(10);
    // Stop once docker has opened the id file: its create is under way.
    for (let tries = 0; tries < 100 && !existsSync(folder ?? ''); tries += 1) {
      // oxlint-disable-next-line no-await-in-loop -- wait for the stand-in to open the file
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    }
    await run.stop();
    expect(readFileSync(calls, 'utf8')).toBe(`rm --force --volumes ${name}\n`);
    expect(existsSync(join(folder ?? '', '..'))).toBe(false);
  } finally {
    process.env['PATH'] = path;
  }
});
