// SPDX-License-Identifier: AGPL-3.0-only
//
// Reviewer proof (R5): restart-proof.sh ended at each step that
// reads then acts (docker run, readiness then psql, the FIFO arming), and run
// again afterwards. What it created is removed by its id however it ends, and
// what a crashed run left behind never stops or harms the next run.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { pause, type Sandbox, sandbox, until } from './restart-proof-sandbox.ts';

const boxes: Sandbox[] = [];
afterEach(() => {
  for (const box of boxes.splice(0)) box.remove();
});

/** A daemon whose `run` (or `exec ... psql`) creates, then holds until STANDIN_DIR/release. */
const holding = (step: 'run' | 'psql') => `
hold() { touch "$STANDIN_DIR/held"; while [ ! -e "$STANDIN_DIR/release" ]; do sleep 0.05; done; }
case "$1" in
  inspect) exit 1 ;;
  image) exit 0 ;;
  run) ${step === 'run' ? 'touch "$STANDIN_DIR/created"; hold;' : ''} echo cid-created ;;
  exec) case " $* " in *" psql "*) ${step === 'psql' ? 'hold;' : ':'} ;; esac ;;
  port) echo "127.0.0.1:$STANDIN_PORT" ;;
esac
exit 0
`;

async function interrupted(step: 'run' | 'psql'): Promise<Sandbox> {
  const box = sandbox(holding(step));
  boxes.push(box);
  const run = box.start();
  expect(await until(() => existsSync(join(box.dir, 'held')), 10_000)).toBe(true);
  const ended = new Promise((done) => {
    run.once('close', done);
  });
  run.kill('SIGTERM');
  await pause(300);
  writeFileSync(join(box.dir, 'release'), '');
  await ended;
  return box;
}

it('ended by SIGTERM during docker run, the container docker created is removed', async () => {
  const box = await interrupted('run');
  // The daemon created cid-created under NAME; the run must not leave it behind.
  expect(
    box.docker().filter((call) => call.startsWith('rm ')),
    box.docker().join('\n'),
  ).not.toStrictEqual([]);
}, 20_000);

it('ended by SIGTERM between the port check and the migrations, it removes its container by id', async () => {
  const box = await interrupted('psql');
  expect(box.docker().filter((call) => call.startsWith('rm '))).toStrictEqual([
    'rm -f -v cid-created',
  ]);
  expect(existsSync(join(box.dir, 'migrated'))).toBe(false);
}, 20_000);

it('a stale keeper FIFO and pid file from a crashed run do not stop or harm the next run', async () => {
  const box = sandbox();
  boxes.push(box);
  const bystander = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    spawnSync('mkfifo', [`${box.evidence}.keeper`]);
    writeFileSync(`${box.evidence}.pids`, `${String(bystander.pid)}\n`);
    const ran = await box.run();
    expect(ran.status, ran.out).toBe(0);
    await pause(100);
    expect(bystander.signalCode).toBe(null);
  } finally {
    bystander.kill('SIGKILL');
  }
}, 20_000);

it('a rerun after a crash that left the container refuses it and removes nothing', async () => {
  const box = sandbox(`
case "$1" in
  inspect) exit 0 ;;
esac
exit 0
`);
  boxes.push(box);
  const ran = await box.run();
  expect(ran.status).toBe(2);
  expect(ran.out).toMatch(/already exists/u);
  expect(box.docker().filter((call) => /^(?:rm|run) /u.test(call))).toStrictEqual([]);
}, 20_000);
