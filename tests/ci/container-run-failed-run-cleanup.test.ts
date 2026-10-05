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
const oks = join(bin, 'rm-oks');
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
  stop: () => Promise<void>;
};

/**
 * A stand-in docker whose `run` does `create`. Its `rm` removes, except that
 * after the first `okFirst` it refuses `rmFailures` times with `refusal`.
 */
function standIn(
  create: string[],
  rmFailures = 0,
  { okFirst = 0, refusal = 'Error response from daemon: transient' } = {},
): void {
  writeFileSync(calls, '');
  writeFileSync(failures, String(rmFailures));
  writeFileSync(oks, String(okFirst));
  rmSync(containers, { recursive: true, force: true });
  mkdirSync(containers);
  writeFileSync(
    join(bin, 'docker'),
    [
      '#!/bin/sh',
      `if [ "$1" = rm ]; then echo "$*" >> "${calls}"; for last; do :; done`,
      `  ok=$(cat "${oks}"); if [ "$ok" -gt 0 ]; then echo $((ok - 1)) > "${oks}"; rm -f "${containers}/$last"; exit 0; fi`,
      `  left=$(cat "${failures}"); if [ "$left" -gt 0 ]; then echo $((left - 1)) > "${failures}"`,
      `    echo '${refusal}' >&2; exit 1; fi`,
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

/** Once docker has written the id, the client dies by a signal and every removal is refused with `refusal`. */
async function killedAfterIdRefused(refusal: string) {
  standIn([`echo ${ID} > "$cid"`, 'exec /bin/sleep 30'], 99, { refusal });
  const { run } = await started();
  const cidfile = run.child.spawnargs.find((a) => a.startsWith('--cidfile='))?.slice(10) ?? '';
  for (let tries = 0; tries < 200 && !existsSync(cidfile); tries += 1) {
    // oxlint-disable-next-line no-await-in-loop -- wait for the stand-in to open the file
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  await new Promise((resolve) => {
    setTimeout(resolve, 100);
  });
  run.child.kill('SIGKILL');
  return { run };
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
  const kept = /id file (\S+) is kept/u.exec(failure.message)?.[1] ?? '';
  expect(readFileSync(kept, 'utf8').trim()).toBe(ID);
  rmSync(join(kept, '..'), { recursive: true, force: true });
}, 15_000);

it('a removal docker answers is already under way counts as gone', async () => {
  const { run } = await killedAfterIdRefused(
    `Error response from daemon: removal of container ${ID} is already in progress`,
  );
  expect(await run.exited).toBe(false);
}, 15_000);

it('with no docker at all, a run fails without claiming a container was left', async () => {
  rmSync(join(bin, 'docker'), { force: true });
  process.env['PATH'] = bin;
  try {
    const { run } = await started();
    expect(await run.exited).toBe(false);
  } finally {
    process.env['PATH'] = `${bin}:${path ?? ''}`;
  }
}, 15_000);

it("a stop whose late removal by the run's name is refused fails, naming the run", async () => {
  // A create under way when the stop comes, which ends with no id.
  standIn(['/bin/sleep 0.3', 'rm -f "$cid"', 'exit 125'], 99, {
    okFirst: 1,
  });
  const { run, arg } = await started();
  for (let tries = 0; tries < 100 && !existsSync(arg('--cidfile=')); tries += 1) {
    // oxlint-disable-next-line no-await-in-loop -- wait for the stand-in to open the file
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  await expect(run.stop()).rejects.toThrow(arg('--name='));
}, 40_000);

const leftBehind = () => Promise.reject(new Error(`docker would not remove container ${ID}`));

const storeRefused = () => Promise.reject(new Error('the store refused'));

it('a backup whose dump container docker will not remove still answers one failed record', async () => {
  const module = '../../scripts/ops/backup.mjs';
  const { runBackup } = (await import(
    /* @vite-ignore */
    module
  )) as { runBackup: (options: Record<string, unknown>) => Promise<Record<string, unknown>> };
  const source = Object.assign((async function* () {})(), { stop: leftBehind });
  for (const publicKey of ['not a key', undefined]) {
    // oxlint-disable-next-line no-await-in-loop -- each failing stage on its own
    const record = await runBackup({
      dump: () => Promise.resolve(source),
      storeUrl: 'unused',
      publicKey,
      reach: storeRefused,
    });
    expect(record, String(publicKey)).toMatchObject({ outcome: 'failed', stage: 'container' });
  }
});
