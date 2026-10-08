// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { A, timerWorld } from './task-bound-timer-support.tsx';
import { copied, realm } from './task-timer-recovery-support.tsx';

const TIMER = 'ops-astro.task-timer';
const STRIP = '[data-task-timer-strip]';
const PAGE = 'main [data-time-log-section] [data-timer]';
const RETRY = '[data-task-timer-retry]';
const noReply = (): void => {};
const ENTRY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

it('fresh App realm replays ID-only Start recovery after task denial and freezes its own Stop entry', async () => {
  const world = timerWorld();
  world.loseStart();
  const first = await realm(world.fetch);
  await first.view.click(PAGE);
  await first.tick();
  const intent = world.writes()[0]!;
  const saved = copied(first.storage);
  expect(JSON.parse(saved.getItem(TIMER)!).binding).toBeNull();
  await first.view.unmount();
  world.deny();
  const second = await realm(world.fetch, saved, '/task/Timer-B');
  expect(world.writes()).toEqual([intent]);
  expect(second.view.find(RETRY)).not.toBeNull();
  await second.view.click(RETRY);
  await second.tick();
  expect(world.writes()[1]).toEqual(intent);
  expect(second.view.find(`${STRIP} [data-timer]`)?.textContent).toContain('Task unavailable');
  expect(second.view.text()).not.toContain('Alpha work');
  expect(second.storage.getItem(TIMER)).not.toContain('Alpha work');
  await second.view.click(`${STRIP} [data-timer]`);
  expect(world.writes()[2]?.body).toMatchObject({ taskId: A, expectedEntryId: ENTRY });
  expect(world.finished).toEqual([A]);
  expect(second.storage.getItem(TIMER)).toBeNull();
});

it('App Start replay settlement keeps a newer read denial instead of its captured private labels', async () => {
  const world = timerWorld();
  world.loseStart();
  let hold = false;
  let release = noReply;
  const fetch: typeof globalThis.fetch = (url, init) => {
    const answer = world.fetch(url, init);
    if (!hold || !String(url).endsWith('/time/start')) return answer;
    return new Promise<Response>((resolve) => {
      release = () => {
        void answer.then(resolve);
      };
    });
  };
  const first = await realm(fetch);
  await first.view.click(PAGE);
  await first.tick();
  const intent = world.writes()[0]!;
  hold = true;
  try {
    await first.view.click(RETRY);
    expect(world.writes()[1]).toEqual(intent);
    world.deny();
    await first.renderPath(`/task/${A}`);
    await first.tick();
    expect(first.view.text()).not.toContain('Alpha work');
    await first.act(release);
    await first.tick();
    expect(first.view.find(`${STRIP} [data-timer]`)?.textContent).toContain('Task unavailable');
    expect(first.view.text()).not.toContain('Alpha work');
    expect(first.view.text()).not.toContain('Timer-A');
    expect(first.storage.getItem(TIMER)).not.toContain('Alpha work');
    expect(first.storage.getItem(TIMER)).not.toContain('Timer-A');
    await first.view.click(`${STRIP} [data-timer]`);
    expect(world.writes()[2]?.body).toMatchObject({ taskId: A, expectedEntryId: ENTRY });
  } finally {
    release();
  }
});
