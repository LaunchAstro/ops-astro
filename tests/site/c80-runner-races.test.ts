// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's runner when two runs of one job overlap (Sol R1): only one takes an
// unregistered revert for dispatch, and concurrent retries of an unknown
// publish ask a person once. Every provider here is a double.

import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { doubles } from './c80-runner-doubles.ts';
import { runLivePublish, runLiveRevert } from '../../packages/core-commands/src/index.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import {
  approved,
  at,
  expireLease,
  handBack,
  latch,
  publish,
  receipt,
  serverUrl,
  takeOver,
  useRegisterWorld,
  w,
} from './c80-register-world.ts';

useRegisterWorld();

describe.skipIf(serverUrl === undefined)('C80 revert, two runners at once', () => {
  it('lets one of two runners that read no previous revert send it', async () => {
    const id = await approved();
    expect(await publish(id, doubles())).toMatchObject({ kind: 'recorded', state: 'live' });
    // Another worker process: its own module instance and connections.
    vi.resetModules();
    const other = await import('../../packages/core-commands/src/index.ts');
    // A connection each: on one connection the runs would queue, never race.
    const wide = connect(w.world.db.appUrl, { source: 'runtime', max: 4 });
    const [bothSent, secondSent] = latch();
    const [answers, release] = latch();
    let sent = 0;
    const runner = () => {
      const ports = doubles({
        revert: async () => {
          sent += 1;
          ports.seen.reverted += 1;
          if (sent === 2) secondSent();
          await answers;
          return { kind: 'ok', value: { revision: 'rev-3', deploymentId: 'dep-3' } };
        },
      });
      return ports;
    };
    // The row held while both runs queue on their initial read: both read before either takes.
    const runs = await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      await tx.query(
        'select 1 from public.live_corrections where business_id = $1 and id = $2 for update',
        [w.world.business, id],
      );
      const started = [
        runLiveRevert(wide, at(id), runner()),
        other.runLiveRevert(wide, at(id), runner()),
      ];
      await waitingOnLocks(2);
      return started;
    });
    await Promise.race([...runs, bothSent]);
    const calls = sent;
    release();
    await Promise.allSettled(runs);
    await wide.close();
    expect(calls).toBe(1);
  });
});

/** Until `count` sessions wait on a lock to read a correction. */
async function waitingOnLocks(count: number): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polling is sequential
    const [row] = await w.world.db.admin.execute<{ readonly n: number }>(
      `select count(*)::int as n from pg_stat_activity
        where wait_event_type = 'Lock' and query like '%from public.live_corrections c%'`,
    );
    if ((row?.n ?? 0) >= count) return;
    // oxlint-disable-next-line no-await-in-loop -- polling is sequential
    await sleep(25);
  }
  throw new Error('the runs never queued on the correction');
}

describe.skipIf(serverUrl === undefined)('C80 publish, unknown retries at once', () => {
  it('raises one task when a second retry runs while the first is raising it', async () => {
    const id = await approved();
    const crashed = doubles({
      publish: (input) => {
        crashed.seen.dispatched.push(input);
        return Promise.reject(new Error('worker lost after the take'));
      },
    });
    await expect(publish(id, crashed)).rejects.toThrow('worker lost');
    const tasks: string[] = [];
    const [entered, enter] = latch();
    const [held, release] = latch();
    const first = doubles({
      raiseTask: async (reason) => {
        tasks.push(reason);
        enter();
        await held;
      },
    });
    const second = doubles({
      raiseTask: (reason) => {
        tasks.push(reason);
        return Promise.resolve();
      },
    });
    const running = publish(id, first);
    await entered;
    await publish(id, second);
    release();
    await running;
    expect(tasks).toEqual(['OUTCOME_UNKNOWN']);
  });
});

/** An approved correction left unknown by a worker lost after the take, nothing registered. */
async function leftUnknown(): Promise<string> {
  const id = await approved();
  const crashed = doubles({
    publish: (input) => {
      crashed.seen.dispatched.push(input);
      return Promise.reject(new Error('worker lost after the take'));
    },
  });
  await expect(publish(id, crashed)).rejects.toThrow('worker lost');
  return id;
}

/** Healthy retries, counting the tasks they raise. */
const healthy = (tasks: string[]) =>
  doubles({
    raiseTask: (reason) => {
      tasks.push(reason);
      return Promise.resolve();
    },
  });

describe.skipIf(serverUrl === undefined)('C80 publish, an ask whose task was never made', () => {
  it('asks again on the next healthy retry when raising the task failed', async () => {
    const id = await leftUnknown();
    const failing = doubles({ raiseTask: () => Promise.reject(new Error('task service down')) });
    await expect(publish(id, failing)).rejects.toThrow('task service down');
    expect((await receipt(id, 'publish'))['waits_on']?.observed).not.toBe('person');
    const tasks: string[] = [];
    const [first, second] = [healthy(tasks), healthy(tasks)];
    const waits = { kind: 'refused', code: 'OUTCOME_UNKNOWN', waitsOn: 'person' };
    expect([await publish(id, first), await publish(id, second)]).toEqual([waits, waits]);
    expect(tasks).toEqual(['OUTCOME_UNKNOWN']);
    const touched = [first, second].map((ports) => [
      ports.seen.sourceReads,
      ports.seen.dispatched.length,
    ]);
    expect(touched).toEqual([
      [0, 0],
      [0, 0],
    ]);
  });

  it('asks again under a new lease when the worker was lost while raising the task', async () => {
    const id = await leftUnknown();
    const lost = doubles({
      raiseTask: async () => {
        await expireLease();
        throw new Error('worker lost while raising the task');
      },
    });
    await expect(publish(id, lost)).rejects.toThrow('worker lost while raising');
    const next = await takeOver();
    try {
      const tasks: string[] = [];
      const run = { ...at(id), ...next };
      await runLivePublish(w.world.db.app, run, healthy(tasks));
      await runLivePublish(w.world.db.app, run, healthy(tasks));
      expect(tasks).toEqual(['OUTCOME_UNKNOWN']);
    } finally {
      await handBack(next.leaseId);
    }
  });
});
