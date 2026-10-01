// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-BATCH-2 #312, batch 3a, n=10: the host sends to custody with
// `child.send` and listens for no 'error' on the child (custody.ts exchangeWith
// and startCustody). When custody dies and the host has not yet handled its
// 'exit' (the event loop was busy), `exitCode` is still null and the channel
// still reads connected, so the send goes ahead, the write fails with EPIPE,
// and the unhandled 'error' event kills the host: the API, not just custody.
// The dispatch must answer worker_lost, started false, and the host live on.
//
// The scenario runs in a child node process, so the crash it proves is that
// process's and not the test runner's.

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');

/** Custody killed, the loop held ~300 ms so its 'exit' is not yet handled, then a dispatch. */
const SCENARIO = `
const { openCustodyWorld } = await import(process.env.REVIEW_3A_10_ROOT + '/tests/custody/custody-world.ts');
const world = await openCustodyWorld();
process.kill(world.custody.pid, 'SIGKILL');
const until = Date.now() + 300;
while (Date.now() < until) {}
const outcome = await world.custody.dispatch('replay_key', world.request());
process.stdout.write('OUTCOME ' + JSON.stringify(outcome) + '\\n');
await world.close();
`;

it('REVIEW-3A-10: a dispatch to a custody that died before its exit was handled answers worker_lost and the host survives the EPIPE', () => {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', SCENARIO], {
    cwd: ROOT,
    env: { ...process.env, REVIEW_3A_10_ROOT: ROOT },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const said = `exit ${String(run.status)} signal ${String(run.signal)}\nstdout ${run.stdout}\nstderr ${run.stderr}`;
  expect(run.stderr, said).not.toMatch(/Unhandled 'error' event|EPIPE/u);
  expect(run.status, said).toBe(0);
  const line = run.stdout.split('\n').find((text) => text.startsWith('OUTCOME '));
  expect(line, said).toBeDefined();
  expect(JSON.parse((line ?? 'OUTCOME null').slice('OUTCOME '.length))).toEqual({
    kind: 'worker_lost',
    started: false,
    fault: 'ours',
  });
});
