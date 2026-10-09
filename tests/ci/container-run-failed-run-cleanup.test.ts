// SPDX-License-Identifier: AGPL-3.0-only
//
// A run that fails leaves no container behind, or says it could not remove
// one. The stand-in docker keeps each container it makes as a file under
// its name or id, holding the login it was given; `rm` removes that file,
// and can be told to fail a number of times first.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { standIn, type Run } from './container-run-cleanup-fixture.js';

const bin = mkdtempSync(join(tmpdir(), 'container-run-failed-'));
const calls = join(bin, 'calls');
const containers = join(bin, 'containers');
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
  standIn(bin, [`echo ${ID} > "$cid"`, 'exec /bin/sleep 30'], 99, { refusal });
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

/** Waits for the id and, when requested, the stand-in's simulated container. */
async function idWritten(cidfile: string, container = false): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    if (
      existsSync(cidfile) &&
      readFileSync(cidfile, 'utf8').trim() === ID &&
      (!container || existsSync(join(containers, ID)))
    )
      return;
    // oxlint-disable-next-line no-await-in-loop -- wait for the stand-in's requested readiness
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error('The stand-in did not publish the requested container readiness');
}

/** Once docker has written the id, the client dies by a signal. */
async function killedAfterId(rmFailures: number, deferCreate = false) {
  const release = join(bin, 'create-release');
  rmSync(release, { force: true });
  standIn(
    bin,
    [
      `echo ${ID} > "$cid"`,
      ...(deferCreate ? [`while [ ! -f "${release}" ]; do /bin/sleep 0.01; done`] : []),
      `printf 'Running PGPASSWORD=%s\\n' "$PGPASSWORD" > "${containers}/${ID}"`,
      'exec /bin/sleep 30',
    ],
    rmFailures,
  );
  const { run, arg } = await started();
  const cidfile = arg('--cidfile=');
  if (deferCreate) {
    await idWritten(cidfile);
    // The old id-only wait kills the child before this event-loop turn releases creation.
    setImmediate(() => writeFileSync(release, 'ready'));
  }
  try {
    await idWritten(cidfile, true);
  } catch (error) {
    run.child.kill('SIGKILL');
    await run.exited.catch(() => {});
    rmSync(join(cidfile, '..'), { recursive: true, force: true });
    throw error;
  }
  run.child.kill('SIGKILL');
  return { run, cidfile };
}

it("a create that fails after its id file is gone removes the container by the run's own name", async () => {
  // The daemon made the container, its answer was lost: docker deletes the empty file and exits 125.
  standIn(bin, [
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
  try {
    await expect(run.exited).rejects.toThrow(ID);
    expect(readdirSync(containers)).toEqual([ID]);
    expect(readFileSync(cidfile, 'utf8').trim()).toBe(ID);
  } finally {
    rmSync(join(cidfile, '..'), { recursive: true, force: true });
  }
}, 15_000);

it('a client waits for simulated creation after the id is published before it is killed', async () => {
  const { run, cidfile } = await killedAfterId(99, true);
  try {
    await expect(run.exited).rejects.toThrow(ID);
    expect(readFileSync(calls, 'utf8')).toBe(`rm --force --volumes ${ID}\n`.repeat(3));
    expect(readdirSync(containers)).toEqual([ID]);
    expect(readFileSync(cidfile, 'utf8').trim()).toBe(ID);
  } finally {
    rmSync(join(cidfile, '..'), { recursive: true, force: true });
  }
}, 15_000);

it('a dump whose container docker will not remove fails with that reason', async () => {
  standIn(bin, [`echo ${ID} > "$cid"`, `: > "${containers}/${ID}"`, 'exit 1'], 99);
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
  standIn(bin, ['/bin/sleep 0.3', 'rm -f "$cid"', 'exit 125'], 99, {
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

it('a backup whose dump fails before any output and keeps its container records stage container', async () => {
  standIn(bin, [`echo ${ID} > "$cid"`, `: > "${containers}/${ID}"`, 'exit 1'], 99);
  const [{ pgDump }, { runBackup }] = (await Promise.all(
    ['../../scripts/ops/backup-dump.mjs', '../../scripts/ops/backup.mjs'].map(
      (module) => import(module),
    ),
  )) as [
    { pgDump: (url: string) => Promise<unknown> },
    { runBackup: (options: Record<string, unknown>) => Promise<Record<string, unknown>> },
  ];
  let kept = '';
  const record = await runBackup({
    dump: () =>
      pgDump('postgres://backup:fixture-only@source/app').catch((error: unknown) => {
        kept = /id file (\S+) is kept/u.exec((error as Error).message)?.[1] ?? '';
        throw error;
      }),
    storeUrl: 'unused',
    reach: storeRefused,
  });
  expect(record).toMatchObject({ outcome: 'failed', stage: 'container' });
  expect(kept).not.toBe('');
  rmSync(join(kept, '..'), { recursive: true, force: true });
}, 15_000);

/** A run whose client closes cleanly when stopped, once docker has written the id; `rmFailures` refusals. */
async function closesCleanlyAfterId(rmFailures: number) {
  standIn(
    bin,
    [
      `echo ${ID} > "$cid"`,
      `: > "${containers}/${ID}"`,
      '/bin/sleep 30 & s=$!',
      "trap 'kill $s; exit 0' TERM INT",
      'wait',
    ],
    rmFailures,
  );
  const { run, arg } = await started();
  const cidfile = arg('--cidfile=');
  await idWritten(cidfile);
  return { run, cidfile };
}

it('a stop whose removal by id is refused fails, naming the container, even when the client then closes cleanly', async () => {
  const { run, cidfile } = await closesCleanlyAfterId(99);
  await expect(run.stop()).rejects.toThrow(ID);
  expect(readdirSync(containers)).toEqual([ID]);
  rmSync(join(cidfile, '..'), { recursive: true, force: true });
}, 40_000);

it('a stop whose removal by id is refused only until the client has closed does not fail', async () => {
  const { run, cidfile } = await closesCleanlyAfterId(3);
  await run.stop();
  expect(readdirSync(containers)).toEqual([]);
  rmSync(join(cidfile, '..'), { recursive: true, force: true });
}, 40_000);
