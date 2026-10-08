// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { entryIdOf, timeWorld, withTimerCleanup, type TimeWorld } from '../commands/time-world.ts';
import { copied, realm } from './task-timer-recovery-support.tsx';
import {
  hidden,
  live,
  outcomes,
  recoveryWorld,
  restoreTime,
  revokeTime,
  PAGE,
  RETRY,
  STRIP,
  TIMER,
} from './task-timer-start-replay-db-support.tsx';

const serverUrl = databaseUrlFromEnvironment();
let w: TimeWorld;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await timeWorld('timerfoundationapp');
}, 180_000);
afterAll(async () => {
  await w?.db.drop();
});
const stop = `${STRIP} [data-timer]`;
function proof(run: () => Promise<void>) {
  return withTimerCleanup(
    () => w,
    async () => {
      try {
        await run();
      } finally {
        await restoreTime(w);
      }
    },
  );
}

it.skipIf(serverUrl === undefined)(
  'fresh App replays a committed unknown Start after task-read loss, then guarded Stop settles once',
  proof(async () => {
    const model = await recoveryWorld(w);
    const first = await realm(model.fetch, undefined, `/task/${model.key}`);
    await model.drain(first);
    await first.view.click(PAGE);
    await model.drain(first);
    const intent = model.writes()[0]!;
    const saved = copied(first.storage);
    expect(JSON.parse(saved.getItem(TIMER)!).binding).toBeNull();
    const entryA = (await w.entries(model.taskId))[0]!.id;
    expect(await outcomes(w, String(intent.body['operationId']))).toEqual(['applied']);
    await first.view.unmount();
    await model.deny();
    const before = model.writes().length;
    const second = await realm(model.fetch, saved, `/task/${model.key}`);
    await model.drain(second);
    expect(model.writes()).toHaveLength(before);
    hidden(second, model.key);
    expect(second.view.find(RETRY)).not.toBeNull();
    await second.view.click(RETRY);
    await model.drain(second);
    expect(model.writes()[1]).toEqual(intent);
    const replay = model.answers[1]!.answer;
    expect(replay).toMatchObject({ recordId: null, revision: null, detail: { entryId: entryA } });
    if (!('detail' in replay)) throw new Error('Start replay returned no own handle');
    expect(Object.keys(replay.detail ?? {}).toSorted()).toEqual(['entryId', 'startedAt']);
    expect(second.view.find(stop)?.textContent).toContain('Task unavailable');
    hidden(second, model.key);
    expect(await outcomes(w, String(intent.body['operationId']))).toEqual(['applied', 'replayed']);
    model.loseStop();
    await second.view.click(stop);
    await model.drain(second);
    const stopped = model.writes()[2]!;
    expect(stopped.body['expectedEntryId']).toBe(entryA);
    expect(await live(w, entryA)).toBe(false);
    await second.view.click(RETRY);
    await model.drain(second);
    expect(model.writes()[3]).toEqual(stopped);
    expect(await outcomes(w, String(stopped.body['operationId']))).toEqual(['applied', 'replayed']);
    expect(await w.entries(model.taskId)).toHaveLength(1);
    expect(second.storage.getItem(TIMER)).toBeNull();
    expect(second.view.find(STRIP)?.textContent).toContain('Select task to time');
    expect(second.view.find(STRIP)?.textContent).toContain('Task time could not be refreshed.');
    expect(second.view.find(`${STRIP} [data-timer][data-running=false]`)).not.toBeNull();
    expect(second.view.find(`${STRIP} [data-timer][data-running=true]`)).toBeNull();
    hidden(second, model.key);
    expect(model.sent.filter((request) => request.path === '/task/board')).toEqual([]);
  }),
);

it.skipIf(serverUrl === undefined)(
  'historical Start replay binds A and a guarded App Stop leaves newer B running after task-read denial',
  proof(async () => {
    const model = await recoveryWorld(w);
    const first = await realm(model.fetch, undefined, `/task/${model.key}`);
    await model.drain(first);
    await first.view.click(PAGE);
    await model.drain(first);
    const intent = model.writes()[0]!;
    const entryA = (await w.entries(model.taskId))[0]!.id;
    const saved = copied(first.storage);
    await first.view.unmount();
    await w.as(w.alpha, w.clientA, {
      command: 'time.stop',
      taskId: model.taskId,
      expectedEntryId: entryA,
    });
    const entryB = entryIdOf(
      await w.as(w.alpha, w.clientA, { command: 'time.start', taskId: model.taskId }),
    );
    expect(entryB).not.toBe(entryA);
    await model.deny();
    const second = await realm(model.fetch, saved, `/task/${model.key}`);
    await model.drain(second);
    await second.view.click(RETRY);
    await model.drain(second);
    expect(model.writes()[1]).toEqual(intent);
    hidden(second, model.key);
    await second.view.click(stop);
    await model.drain(second);
    expect(model.writes()[2]?.body['expectedEntryId']).toBe(entryA);
    expect(second.view.text()).toContain('Timer change refused');
    expect(second.view.text()).toContain('NOT_FOUND');
    expect(await live(w, entryB)).toBe(true);
    expect(await w.entries(model.taskId)).toHaveLength(2);
    hidden(second, model.key);
  }),
);

it.skipIf(serverUrl === undefined)(
  'revoked time-write withholds Start replay and Stop while App keeps the exact unknown until same-owner authority returns',
  proof(async () => {
    const model = await recoveryWorld(w);
    const first = await realm(model.fetch, undefined, `/task/${model.key}`);
    await model.drain(first);
    await first.view.click(PAGE);
    await model.drain(first);
    const intent = model.writes()[0]!;
    const entryA = (await w.entries(model.taskId))[0]!.id;
    const saved = copied(first.storage);
    await first.view.unmount();
    await model.deny();
    await revokeTime(w);
    const second = await realm(model.fetch, saved, `/task/${model.key}`);
    await model.drain(second);
    await second.view.click(RETRY);
    await model.drain(second);
    expect(model.writes()[1]).toEqual(intent);
    expect(second.view.text()).toContain('Timer outcome unknown');
    expect(second.view.text()).toContain('SCOPE_NOT_GRANTED');
    expect(second.view.find(stop)?.hasAttribute('disabled')).toBe(true);
    const refused = await w.as(w.alpha, w.clientA, {
      command: 'time.stop',
      taskId: model.taskId,
      expectedEntryId: entryA,
    });
    expect(refused).toMatchObject({ refused: true, code: 'SCOPE_NOT_GRANTED' });
    expect(JSON.stringify(refused)).not.toContain(entryA);
    expect(await live(w, entryA)).toBe(true);
    hidden(second, model.key);
    const retained = JSON.parse(second.storage.getItem(TIMER)!);
    expect(retained.attempt.operationId).toBe(intent.body['operationId']);
    expect(retained.attempt.payload).toEqual({ taskId: model.taskId });
    await restoreTime(w);
    await second.view.click(RETRY);
    await model.drain(second);
    expect(model.writes()[2]).toEqual(intent);
    hidden(second, model.key);
    await second.view.click(stop);
    await model.drain(second);
    expect(model.writes()[3]?.body['expectedEntryId']).toBe(entryA);
    expect(await live(w, entryA)).toBe(false);
    expect(second.storage.getItem(TIMER)).toBeNull();
  }),
);

it.skipIf(serverUrl === undefined)(
  'a task-read denial delivered before a held Start replay strips captured labels before settlement',
  proof(async () => {
    const model = await recoveryWorld(w);
    const first = await realm(model.fetch, undefined, `/task/${model.key}`);
    await model.drain(first);
    await first.view.click(PAGE);
    await model.drain(first);
    const intent = model.writes()[0]!;
    const held = model.holdReplay();
    try {
      await first.view.click(RETRY);
      await expect.poll(() => model.writes().length).toBe(2);
      await model.deny();
      await first.renderPath(`/task/${model.taskId}`);
      // Wait only for reads so the replay remains held until denial is applied.
      await model.drainReads(first);
      hidden(first, model.key);
      await first.act(held.release);
      await model.drain(first);
      expect(model.writes()[1]).toEqual(intent);
      expect(first.view.find(stop)?.textContent).toContain('Task unavailable');
      hidden(first, model.key);
      await first.view.click(stop);
      await model.drain(first);
      expect(await w.entries(model.taskId)).toHaveLength(1);
    } finally {
      held.release();
    }
  }),
);
