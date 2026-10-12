// SPDX-License-Identifier: AGPL-3.0-only
//
// Reviewer proof (R5): two restart-proof runs at once. Each run
// owns its container name and ports, but the FIFO the keeper reads is a path
// derived from the evidence file, and `verify:restart` and
// `verify:runtime-proofs` both default that to evidence-<head>.txt. A run's
// group must end only when that run ends, and one run must never fail
// because another started or finished beside it.

import { type ChildProcess, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { alive, pause, type Sandbox, sandbox, until } from './restart-proof-sandbox.ts';

/** A `sleep` on the paused run's PATH: `sleep 1` (the arming pause) waits for STANDIN_GATE. */
const GATED_SLEEP = `#!/bin/sh
if [ "$1" = 1 ] && [ -n "\${STANDIN_GATE:-}" ]; then
  while [ ! -e "$STANDIN_GATE" ]; do /bin/sleep 0.05; done
  exit 0
fi
exec /bin/sleep "$@"
`;

const boxes: Sandbox[] = [];
const children: ChildProcess[] = [];

/** Processes still in a run's recorded group: pid and command. */
function groupLeft(box: Sandbox): { pid: number; command: string }[] {
  const groups = new Set(box.recorded('suite').map(({ pgid }) => pgid));
  const table = spawnSync('ps', ['-A', '-o', 'pid=,pgid=,command='], { encoding: 'utf8' });
  return table.stdout.split('\n').flatMap((row) => {
    const [, pid = '0', pgid = '0', command = ''] = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(row) ?? [];
    return groups.has(Number(pgid)) ? [{ pid: Number(pid), command }] : [];
  });
}

/**
 * Ends only what this sandbox started, after checking each command: a member of a
 * recorded group running the sandbox's own script, stand-in or a stand-in's sleep.
 */
function endOwn(box: Sandbox): void {
  for (const { pid, command } of groupLeft(box)) {
    const ours =
      command.includes(box.dir) ||
      /^(?:\/bin\/sleep (?:30|0\.05|0\.1)|tee -a .*restart-proof-)/u.test(command);
    if (ours) process.kill(pid, 'SIGKILL');
  }
  for (const { pid } of [...box.recorded('suite'), ...box.recorded('api')]) {
    const row = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
    if (/(?:sleep 30$|\/bin\/pnpm )/u.test(row.stdout.trim())) process.kill(pid, 'SIGKILL');
  }
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
  await pause(500);
  for (const box of boxes.splice(0)) {
    endOwn(box);
    box.remove();
  }
});

function gatedBox(): { box: Sandbox; gate: string; arming: string } {
  const box = sandbox();
  boxes.push(box);
  const sleep = join(box.dir, 'bin/sleep');
  writeFileSync(sleep, GATED_SLEEP);
  chmodSync(sleep, 0o755);
  return { box, gate: join(box.dir, 'gate'), arming: join(box.dir, 'arming') };
}

const armed = (file: string) => () => existsSync(file) && readFileSync(file, 'utf8').trim() !== '';

/** The exit status, on exit rather than close: a stranded group member can hold its stdio open. */
async function closed(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return await new Promise((done) => {
    child.once('exit', done);
  });
}

it('a run that ends beside another sharing its evidence path never ends or strands the other run', async () => {
  // B forks its job, then pauses before the job opens the FIFO by path.
  const { box: b, gate, arming } = gatedBox();
  const a = sandbox();
  boxes.push(a);
  const finishB = join(b.dir, 'finish');
  const runB = b.start(
    ['--name', 'restart-sandbox-pg-b', '--port', '64061', '--api-port', '64062'],
    {
      STANDIN_SUITE: `while [ ! -e '${finishB}' ]; do sleep 0.05; done`,
      STANDIN_PORT: '64061',
      L5_RESTART_ARMING_PAUSE: arming,
      STANDIN_GATE: gate,
    },
  );
  children.push(runB);
  let outB = '';
  runB.stdout?.on('data', (chunk: Buffer) => (outB += chunk.toString('utf8')));
  runB.stderr?.on('data', (chunk: Buffer) => (outB += chunk.toString('utf8')));
  expect(await until(armed(arming), 10_000), 'B reached its arming pause').toBe(true);

  // A starts beside it on B's evidence path (as the two pnpm scripts' defaults share one).
  const finishA = join(a.dir, 'finish');
  const runA = a.start(['--evidence', b.evidence], {
    STANDIN_SUITE: `while [ ! -e '${finishA}' ]; do sleep 0.05; done`,
  });
  children.push(runA);
  expect(await until(() => a.recorded('api').length > 0, 10_000), 'A suite up').toBe(true);

  // B arms and its suite comes up.
  writeFileSync(gate, '');
  expect(await until(() => b.recorded('api').length > 0, 10_000), 'B suite up').toBe(true);
  const [bApi] = b.recorded('api');

  // A's suite finishes and A exits normally.
  writeFileSync(finishA, '');
  expect(await closed(runA), 'A passed').toBe(0);
  await pause(1000);
  expect(bApi !== undefined && alive(bApi.pid), "B's API, while B is still running").toBe(true);

  // B's suite finishes; B's run ends its own group and passes.
  writeFileSync(finishB, '');
  const statusB = await closed(runB);
  await pause(200);
  expect(groupLeft(b), "B's group after B exited").toStrictEqual([]);
  expect(statusB, `B failed:\n${outB}`).toBe(0);
}, 30_000);

it('a run that finishes beside another sharing its evidence path never fails the other run', async () => {
  const { box: b, gate, arming } = gatedBox();
  const a = sandbox();
  boxes.push(a);
  const runB = b.start(
    ['--name', 'restart-sandbox-pg-b', '--port', '64061', '--api-port', '64062'],
    { STANDIN_PORT: '64061', L5_RESTART_ARMING_PAUSE: arming, STANDIN_GATE: gate },
  );
  children.push(runB);
  expect(await until(armed(arming), 10_000), 'B reached its arming pause').toBe(true);

  const ranA = await a.run(['--evidence', b.evidence]);
  expect(ranA.status, ranA.out).toBe(0);

  let outB = '';
  runB.stdout?.on('data', (chunk: Buffer) => (outB += chunk.toString('utf8')));
  runB.stderr?.on('data', (chunk: Buffer) => (outB += chunk.toString('utf8')));
  writeFileSync(gate, '');
  const statusB = await closed(runB);
  expect(statusB, `B, whose suite exits 0, failed:\n${outB}`).toBe(0);
}, 30_000);

it('two runs with one container name: the loser never removes the winner container', async () => {
  const host = sandbox();
  boxes.push(host);
  const shared = join(host.dir, 'daemon');
  mkdirSync(shared, { recursive: true });
  // One daemon: the first `run` takes the name, the second is refused as Docker refuses it.
  const daemon = `
case "$1" in
  inspect) [ -d '${shared}/owner' ] && exit 0; exit 1 ;;
  image) exit 0 ;;
  run)
    sleep 0.3
    if mkdir '${shared}/owner' 2>/dev/null; then echo "cid-$$"; exit 0; fi
    echo 'Conflict. The container name is already in use' >&2; exit 125 ;;
  port) echo "127.0.0.1:$STANDIN_PORT" ;;
esac
exit 0
`;
  const one = sandbox(daemon);
  const two = sandbox(daemon);
  boxes.push(one, two);
  const [ranOne, ranTwo] = await Promise.all([one.run(), two.run()]);
  const statuses = [ranOne.status, ranTwo.status].toSorted();
  expect(statuses, ranOne.out + ranTwo.out).toStrictEqual([0, 125]);
  const loser = ranOne.status === 0 ? two : one;
  expect(loser.docker().filter((call) => call.startsWith('rm '))).toStrictEqual([]);
}, 30_000);
