// SPDX-License-Identifier: AGPL-3.0-only
//
// A stopped run whose docker client ignores SIGTERM is killed after its
// grace, so the stop ends and the job behind it is not held. The stand-in
// docker writes its container's id, then ignores INT and TERM and closes
// only on SIGKILL; every `kill` and `rm` it is asked for succeeds.

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const bin = mkdtempSync(join(tmpdir(), 'container-run-kill-'));
afterAll(() => rmSync(bin, { recursive: true, force: true }));

type Run = { child: { spawnargs: string[] }; stop: () => Promise<void> };

writeFileSync(
  join(bin, 'docker'),
  [
    '#!/bin/sh',
    'case "$1" in kill|rm) exit 0 ;; esac',
    'for arg in "$@"; do case $arg in --cidfile=*) cid="${arg#--cidfile=}" ;; esac; done',
    `printf '%s' '${'b'.repeat(64)}' > "$cid"`,
    "trap '' INT TERM",
    '/bin/sleep 20 > /dev/null 2>&1 &',
    'while :; do wait; done',
    '',
  ].join('\n'),
);
chmodSync(join(bin, 'docker'), 0o755);

it('kills a docker client that ignores its stop, and the stop ends', async () => {
  const path = process.env['PATH'];
  process.env['PATH'] = `${bin}:${path ?? ''}`;
  try {
    const module = '../../scripts/ops/container-run.mjs';
    const { runContainer } = (await import(
      /* @vite-ignore */
      module
    )) as { runContainer: (...args: unknown[]) => Run };
    const run = runContainer('store', 'none', { PGHOST: 'backups' }, ['psql']);
    const cidfile = run.child.spawnargs.find((a) => a.startsWith('--cidfile='))?.slice(10) ?? '';
    for (
      let tries = 0;
      tries < 100 && !(existsSync(cidfile) && readFileSync(cidfile, 'utf8'));
      tries += 1
    ) {
      // oxlint-disable-next-line no-await-in-loop -- wait for the stand-in to write its id
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    }
    const ended = await Promise.race([
      run.stop().then(() => 'stopped'),
      new Promise((resolve) => {
        setTimeout(() => resolve('held'), 10_000);
      }),
    ]);
    expect(ended, 'a client ignoring SIGTERM held the stop past its grace').toBe('stopped');
  } finally {
    process.env['PATH'] = path;
  }
}, 20_000);
