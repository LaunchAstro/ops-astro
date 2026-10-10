// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import type { RankView } from '../../packages/core-wire/src/index.ts';
import {
  priorityWorld,
  priorityTask,
  priorityApplied,
  readPriority,
  setPriority,
} from '../commands/priority-stages-support.ts';
import { readRankTask, type RankCoreWorld } from './task-rank-core-world.ts';
import {
  bounded,
  holdRankReply,
  snapshotWriter,
  commitSnapshotChange,
  type Backend,
  type ReplyBarrier,
} from './priority-stage-snapshot-support.ts';

let world: RankCoreWorld | undefined;
function here(): RankCoreWorld {
  if (world === undefined) throw new Error('Snapshot fixture did not open its owned database');
  return world;
}
beforeAll(async () => {
  world = await priorityWorld();
}, 180_000);
afterAll(async () => {
  await world?.db.drop();
});

async function projection(
  app: Database,
  w: RankCoreWorld,
  target: string,
  surface: 'page' | 'board',
): Promise<RankView> {
  const answer = await executeRead(
    app,
    w.business,
    w.owner.presented,
    surface === 'page'
      ? { read: 'task.read', recordId: target }
      : { read: 'task.board', board: null },
  );
  if (isCommandRefusal(answer)) throw new Error(`Snapshot canonical read refused ${answer.code}`);
  if ('task' in answer) return answer.task.rank;
  if ('tasks' in answer) {
    const own = answer.tasks.find((row) => row.id === target);
    if (own !== undefined) return own.rank;
  }
  throw new Error('Snapshot canonical read omitted the target projection');
}

async function acknowledgedReply(
  barrier: ReplyBarrier,
  heldRead: Promise<RankView>,
): Promise<Backend> {
  const readerBackend = await bounded(
    'actual target pool reply',
    Promise.race([
      barrier.arrived,
      heldRead.then(() => {
        throw new Error('Snapshot canonical read settled without acknowledging its target pool');
      }),
    ]),
  );
  expect(barrier.heldCount()).toBe(1);
  return readerBackend;
}

async function commitAndObserve(
  writer: Database,
  w: RankCoreWorld,
  target: { readonly id: string; readonly revision: number },
  settingRevision: number,
  readerBackend: Backend,
): Promise<void> {
  const committed = await bounded(
    'atomic canonical writer commit',
    commitSnapshotChange(w, writer, target, settingRevision),
  );
  expect(committed.backend.isolation).toBe('read committed');
  expect(readerBackend.isolation).toBe('read committed');
  expect(committed.backend.pid).not.toBe(readerBackend.pid);
  // The outer withBusiness resolves only after COMMIT. A different real
  // transaction on the writer connection now observes that committed state.
  const observed = await bounded(
    'committed task readback',
    executeRead(writer, w.business, w.owner.presented, {
      read: 'task.read',
      recordId: target.id,
    }),
  );
  expect(observed).toMatchObject({
    task: {
      revision: committed.taskRevision,
      stage: 'sales',
      scores: { impact: 10, confidence: 9, ease: 10 },
      startedAt: null,
      rank: { score: 900 },
    },
  });
  const settings = await bounded(
    'committed setting readback',
    executeRead(writer, w.business, w.owner.presented, { read: 'settings.read' }),
  );
  if (isCommandRefusal(settings) || !('settings' in settings))
    throw new Error('Snapshot committed setting readback refused');
  expect(settings.settings.find((row) => row.key === 'priority_stages')).toMatchObject({
    value: ['trust'],
    revision: settingRevision + 1,
  });
}

for (const surface of ['page', 'board'] as const) {
  it(`keeps ${surface} rank inputs in one statement snapshot across a real atomic commit`, async () => {
    const w = here();
    priorityApplied(await setPriority(w, [], (await readPriority(w)).revision));
    const target = await priorityTask(w, 'trust');
    const initial = await readRankTask(w, target.id);
    expect(initial).toMatchObject({ revision: target.revision, stage: 'trust', startedAt: null });
    expect(initial.rank).toMatchObject({
      score: 504,
      calc: 'impact 7 × confidence 9 × ease 8 × priority 1 × age 1 = 504 · derived',
    });
    const setting = await readPriority(w);
    expect(setting.value).toStrictEqual([]);
    const barrier = holdRankReply(w.db.app, target.id);
    const writer = snapshotWriter(w);
    const heldRead = projection(barrier.database, w, target.id, surface);
    // Handle early rejection while awaiting the real reply acknowledgement.
    void heldRead.catch(() => {});
    try {
      const readerBackend = await acknowledgedReply(barrier, heldRead);
      await commitAndObserve(writer, w, target, setting.revision, readerBackend);
      barrier.release();
      const held = await bounded('held canonical read settlement', heldRead);
      expect(held).toMatchObject({
        score: 504,
        calc: 'impact 7 × confidence 9 × ease 8 × priority 1 × age 1 = 504 · derived',
      });
      expect(
        await bounded('fresh canonical projection', projection(writer, w, target.id, surface)),
      ).toMatchObject({
        score: 900,
        calc: 'impact 10 × confidence 9 × ease 10 × priority 1 × age 1 = 900 · derived',
      });
      expect(barrier.heldCount()).toBe(1);
    } finally {
      barrier.release();
      // Never drop a fixture with an unsettled canonical child. The finite
      // owned launcher independently verifies sessions/processes on failure.
      try {
        await bounded(
          'drain held reader',
          heldRead.catch(() => {}),
        );
      } finally {
        await bounded('close owned writer', writer.close());
      }
    }
  });
}
