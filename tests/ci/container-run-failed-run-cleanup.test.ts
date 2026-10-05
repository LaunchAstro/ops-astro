// SPDX-License-Identifier: AGPL-3.0-only
//
// A run that fails leaves no container behind, or says it could not remove
// one. The stand-in docker keeps each container it makes as a file under
// its name or id, holding the login it was given; `rm` removes that file,
// and can be told to fail a number of times first.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

const bin = mkdtempSync(join(tmpdir(), 'container-run-failed-'));
const calls = join(bin, 'calls');
const containers = join(bin, 'containers');
const failures = join(bin, 'rm-failures');
const ID = 'b'.repeat(64);
// The stand-in answers every docker call of the file, the cleanup's after the run included.
const path = process.env['PATH'];
beforeAll(() => {
  process.env['PATH'] = `${bin}:${path ?? ''}`;
});
afterAll(() => {
  process.env['PATH'] = path;
  rmSync(bin, { recursive: true, force: true });
});

type Run = {
  child: { spawnargs: string[]; kill: (signal: string) => boolean };
  exited: Promise<boolean>;
};

/** A stand-in docker: `rm` fails `rmFailures` times, then removes; `run` does `create`. */
function standIn(create: string[], rmFailures = 0): void {
  writeFileSync(calls, '');
  writeFileSync(failures, String(rmFailures));
  rmSync(containers, { recursive: true, force: true });
  mkdirSync(containers);
  writeFileSync(
    join(bin, 'docker'),
    [
      '#!/bin/sh',
      `if [ "$1" = rm ]; then echo "$*" >> "${calls}"; for last; do :; done`,
      `  left=$(cat "${failures}"); if [ "$left" -gt 0 ]; then echo $((left - 1)) > "${failures}"`,
      "    echo 'Error response from daemon: transient' >&2; exit 1; fi",
      `  rm -f "${containers}/$last"; exit 0; fi`,
      `if [ "$1" = kill ]; then echo "$*" >> "${calls}"; exit 0; fi`,
      'for arg in "$@"; do case $arg in --cidfile=*) cid="${arg#--cidfile=}" ;; --name=*) name="${arg#--name=}" ;; esac; done',
      ': > "$cid"',
      ...create,
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'docker'), 0o755);
}

async function started(): Promise<{ run: Run; arg: (prefix: string) => string }> {
  const module = '../../scripts/ops/container-run.mjs';
  const { runContainer } = (await import(
    /* @vite-ignore */
    module
  )) as { runContainer: (...args: unknown[]) => Run };
  const run = runContainer('store', 'none', { PGHOST: 'backups', PGPASSWORD: 'fixture-only' }, [
    'psql',
  ]);
  const arg = (prefix: string) =>
    run.child.spawnargs.find((a) => a.startsWith(prefix))?.slice(prefix.length) ?? '';
  return { run, arg };
}

/** Once docker has written the id, the client dies by a signal. */
async function killedAfterId(rmFailures: number) {
  standIn(
    [
      `echo ${ID} > "$cid"`,
      `printf 'Running PGPASSWORD=%s\\n' "$PGPASSWORD" > "${containers}/${ID}"`,
      'exec /bin/sleep 30',
    ],
    rmFailures,
  );
  const { run, arg } = await started();
  const cidfile = arg('--cidfile=');
  for (let tries = 0; tries < 200; tries += 1) {
    if (existsSync(cidfile) && readFileSync(cidfile, 'utf8').trim() === ID) break;
    // oxlint-disable-next-line no-await-in-loop -- wait for the stand-in to write the id
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  run.child.kill('SIGKILL');
  return { run, cidfile };
}

it("a create that fails after its id file is gone removes the container by the run's own name", async () => {
  // The daemon made the container, its answer was lost: docker deletes the empty file and exits 125.
  standIn([
    `printf 'Created PGPASSWORD=%s\\n' "$PGPASSWORD" > "${containers}/$name"`,
    'rm -f "$cid"',
    'exit 125',
  ]);
  const { run, arg } = await started();
  expect(await run.exited).toBe(false);
  const name = arg('--name=');
  expect(readFileSync(calls, 'utf8')).toContain(`rm --force --volumes ${name}`);
  expect(readdirSync(containers)).toEqual([]);
  expect(existsSync(join(arg('--cidfile='), '..'))).toBe(false);
}, 15_000);

it('a removal that fails once is tried again, and the container goes', async () => {
  const { run, cidfile } = await killedAfterId(1);
  expect(await run.exited).toBe(false);
  expect(readFileSync(calls, 'utf8')).toBe(
    `rm --force --volumes ${ID}\nrm --force --volumes ${ID}\n`,
  );
  expect(readdirSync(containers)).toEqual([]);
  expect(existsSync(join(cidfile, '..'))).toBe(false);
}, 15_000);

it('a removal that keeps failing fails the run, names the container and keeps its id file', async () => {
  const { run, cidfile } = await killedAfterId(99);
  await expect(run.exited).rejects.toThrow(ID);
  expect(readdirSync(containers)).toEqual([ID]);
  expect(readFileSync(cidfile, 'utf8').trim()).toBe(ID);
  rmSync(join(cidfile, '..'), { recursive: true, force: true });
}, 15_000);

it('a dump whose container docker will not remove fails with that reason', async () => {
  standIn([`echo ${ID} > "$cid"`, `: > "${containers}/${ID}"`, 'exit 1'], 99);
  const module = '../../scripts/ops/backup-dump.mjs';
  const { pgDump } = (await import(
    /* @vite-ignore */
    module
  )) as { pgDump: (url: string) => Promise<unknown> };
  const failure = await pgDump('postgres://backup:fixture-only@source/app').then(
    () => new Error('the dump answered'),
    (error: unknown) => error as Error,
  );
  expect(failure.message).toContain(ID);
  expect(readdirSync(containers)).toEqual([ID]);
  // The id file it names is kept for that removal; the test clears it.
  const kept = /its id file (\S+) is kept/u.exec(failure.message)?.[1] ?? '';
  expect(readFileSync(kept, 'utf8').trim()).toBe(ID);
  rmSync(join(kept, '..'), { recursive: true, force: true });
}, 15_000);
