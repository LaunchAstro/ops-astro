// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { draftTab } from './projects-draft-app-support.tsx';
import { copied, realm } from './task-timer-recovery-support.tsx';
import { A, timerWorld } from './task-bound-timer-support.tsx';

const TIMER = 'ops-astro.task-timer';
const strip = '[data-task-timer-strip]';
const pageTimer = 'main [data-time-log-section] [data-timer]';
const noReply = (): void => {};

for (const command of ['start', 'stop'] as const) {
  it(`fresh realm retains the exact unknown ${command} without automatic replay`, async () => {
    const world = timerWorld();
    if (command === 'start') world.loseStart();
    const first = await realm(world.fetch);
    await first.view.click(pageTimer);
    if (command === 'stop') {
      world.loseStop();
      await first.view.click(`${strip} [data-timer]`);
    }
    await first.tick();
    const intent = world.writes().at(-1)!;
    const kept = first.storage.getItem(TIMER);
    expect(kept).not.toBeNull();
    expect(kept).toContain(String(intent.body['operationId']));
    expect(kept).not.toContain('Alpha work');
    const storage = copied(first.storage);
    await first.view.unmount();
    const before = world.writes().length;
    const second = await realm(world.fetch, storage, '/task/Timer-B');
    expect(world.writes()).toHaveLength(before);
    expect(second.view.find('[data-task-timer-retry]')).not.toBeNull();
    expect(second.view.find(`${strip} [data-timer]`)?.hasAttribute('disabled')).toBe(true);
    await second.view.click('[data-task-timer-retry]');
    await second.tick();
    expect(world.writes().at(-1)).toEqual(intent);
    if (command === 'start') await second.view.click(`${strip} [data-timer]`);
    expect(world.finished).toEqual([A]);
    expect(second.storage.getItem(TIMER)).toBeNull();
  });
}

it('reload re-reads known A by UUID while B is open and preserves safe Stop after denial', async () => {
  const world = timerWorld();
  const first = await realm(world.fetch);
  await first.view.click(pageTimer);
  const storage = copied(first.storage);
  const forged = JSON.parse(storage.getItem(TIMER)!);
  forged.binding.task.title = 'Stored private title';
  forged.binding.task.key = 'Stored-private-key';
  forged.permissions = { taskRead: true, taskWrite: true };
  storage.setItem(TIMER, JSON.stringify(forged));
  await first.view.unmount();
  world.deny();
  const before = world.sent.length;
  const second = await realm(world.fetch, storage, '/task/Timer-B');
  expect(world.sent.slice(before).some((request) => request.body['recordId'] === A)).toBe(true);
  expect(second.view.find(strip)?.textContent).not.toContain('Alpha work');
  expect(second.view.find(strip)?.textContent).not.toContain('Timer-A');
  expect(second.view.text()).not.toContain('Stored private title');
  expect(second.view.text()).not.toContain('Stored-private-key');
  expect(second.view.find(`${strip} [data-timer]`)?.hasAttribute('disabled')).toBe(false);
  await second.view.click(`${strip} [data-timer]`);
  expect(world.writes().at(-1)?.body['taskId']).toBe(A);
  expect(world.finished).toEqual([A]);
});

it('a newer UUID recovery denial prevents an older page-key read from drawing labels', async () => {
  const world = timerWorld();
  const first = await realm(world.fetch);
  await first.view.click(pageTimer);
  const storage = copied(first.storage);
  await first.view.unmount();
  let release = noReply;
  const fetch: typeof globalThis.fetch = (url, init) => {
    if (!String(url).endsWith('/task/read')) return world.fetch(url, init);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (body['recordId'] === A)
      return Promise.resolve(
        new Response(JSON.stringify({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }), {
          status: 404,
        }),
      );
    const answer = world.fetch(url, init);
    return new Promise<Response>((resolve) => {
      release = () => void answer.then(resolve);
    });
  };
  const second = await realm(fetch, storage);
  expect(second.view.find(strip)?.textContent).not.toContain('Alpha work');
  await second.act(release);
  await second.tick();
  expect(second.view.text()).not.toContain('Alpha work');
  expect(second.view.find(`${strip} [data-timer]`)?.hasAttribute('disabled')).toBe(false);
});

it('unknown then refused retry remains uncertain through another fresh realm', async () => {
  const world = timerWorld();
  const first = await realm(world.fetch);
  await first.view.click(pageTimer);
  world.loseStop();
  await first.view.click(`${strip} [data-timer]`);
  const intent = world.writes().at(-1)!;
  const storage = copied(first.storage);
  await first.view.unmount();
  const refused: typeof globalThis.fetch = (url, init) =>
    String(url).endsWith('/time/stop')
      ? Promise.resolve(
          new Response(
            JSON.stringify({ refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] }),
            { status: 403 },
          ),
        )
      : world.fetch(url, init);
  const second = await realm(refused, storage);
  expect(second.view.find('[data-task-timer-retry]')).not.toBeNull();
  await second.view.click('[data-task-timer-retry]');
  expect(second.view.text()).toContain('SCOPE_NOT_GRANTED');
  expect(second.view.text()).not.toContain('Dismiss refusal');
  const next = copied(second.storage);
  await second.view.unmount();
  const third = await realm(world.fetch, next);
  expect(third.view.find('[data-task-timer-retry]')).not.toBeNull();
  await third.view.click('[data-task-timer-retry]');
  expect(world.writes().at(-1)).toEqual(intent);
  expect(world.finished).toEqual([A]);
});

it('a pending response reloads as explicit unknown without sending a second command', async () => {
  const world = timerWorld();
  const never = new Promise<Response>(() => {});
  const fetch: typeof globalThis.fetch = (url, init) =>
    String(url).endsWith('/time/start') ? never : world.fetch(url, init);
  const first = await realm(fetch);
  await first.view.click(pageTimer);
  expect(first.view.text()).toContain('Saving timer');
  const storage = copied(first.storage);
  await first.view.unmount();
  const before = world.writes().length;
  const second = await realm(world.fetch, storage);
  expect(world.writes()).toHaveLength(before);
  expect(second.view.find('[data-task-timer-retry]')).not.toBeNull();
});

it('failed persistence stays visibly memory-only and retains the exact in-tab retry', async () => {
  const world = timerWorld();
  world.loseStart();
  const storage = draftTab();
  const original = storage.setItem;
  storage.setItem = (key, value) => {
    if (key === TIMER) throw new Error('Synthetic storage denied');
    original(key, value);
  };
  const first = await realm(world.fetch, storage);
  await first.view.click(pageTimer);
  const intent = world.writes().at(-1)!;
  expect(first.view.text()).toContain('only in this tab');
  expect(storage.getItem(TIMER)).toBeNull();
  await first.view.click('[data-task-timer-retry]');
  expect(world.writes().at(-1)).toEqual(intent);
});

it('another admitted owner cannot inherit a persisted timer or replay its intent', async () => {
  const world = timerWorld();
  const first = await realm(world.fetch);
  await first.view.click(pageTimer);
  expect(first.storage.getItem(TIMER)).not.toBeNull();
  const storage = copied(first.storage);
  await first.view.unmount();
  storage.setItem(
    'ops-astro.session',
    JSON.stringify({ businessKey: 'bravo', email: 'other@example.test' }),
  );
  const before = world.writes().length;
  const second = await realm(world.fetch, storage, '/projects');
  expect(second.view.find(strip)?.textContent).toBe('Select task to time');
  expect(second.storage.getItem(TIMER)).toBeNull();
  expect(world.writes()).toHaveLength(before);
});

it('a business departure clears custody even when the same owner returns before rendering', async () => {
  const world = timerWorld();
  const first = await realm(world.fetch);
  await first.view.click(pageTimer);
  expect(first.storage.getItem(TIMER)).not.toBeNull();
  const home = first.sessions.session!;
  await first.act(() => {
    first.sessions.set({ ...home, businessKey: 'bravo' });
    first.sessions.set(home);
  });
  expect(first.storage.getItem(TIMER)).toBeNull();
  await first.view.unmount();
  const second = await realm(world.fetch, copied(first.storage), '/projects');
  expect(second.view.find(strip)?.textContent).toBe('Select task to time');
});

it('an old-owner delayed answer cannot repopulate custody after departure', async () => {
  const world = timerWorld();
  let release = noReply;
  let waiting = false;
  const fetch: typeof globalThis.fetch = (url, init) => {
    const response = world.fetch(url, init);
    return String(url).endsWith('/time/start')
      ? new Promise<Response>((resolve) => {
          waiting = true;
          release = () => void response.then(resolve);
        })
      : response;
  };
  const first = await realm(fetch);
  await first.view.click(pageTimer);
  expect(first.storage.getItem(TIMER)).not.toBeNull();
  const home = first.sessions.session!;
  await first.act(() => {
    first.sessions.set({ ...home, businessKey: 'bravo' });
    first.sessions.set(home);
  });
  expect(first.storage.getItem(TIMER)).toBeNull();
  expect(waiting).toBe(true);
  await first.act(release);
  await first.tick();
  expect(first.storage.getItem(TIMER)).toBeNull();
});

it('same-owner transport refresh keeps the durable envelope and fences the old answer', async () => {
  const world = timerWorld();
  let release = noReply;
  const delayed: typeof globalThis.fetch = (url, init) => {
    const answer = world.fetch(url, init);
    return String(url).endsWith('/time/start')
      ? new Promise<Response>((resolve) => {
          release = () => void answer.then(resolve);
        })
      : answer;
  };
  const first = await realm(delayed);
  await first.view.click(pageTimer);
  const intent = world.writes().at(-1)!;
  expect(first.storage.getItem(TIMER)).toContain(String(intent.body['operationId']));
  await first.renderFetch(world.fetch);
  expect(first.view.find('[data-task-timer-retry]')).not.toBeNull();
  await first.act(release);
  await first.tick();
  expect(first.view.find('[data-task-timer-retry]')).not.toBeNull();
  await first.view.click('[data-task-timer-retry]');
  expect(world.writes().at(-1)).toEqual(intent);
});

it('failed removal is visible after settlement instead of promising current durable custody', async () => {
  const world = timerWorld();
  const first = await realm(world.fetch);
  await first.view.click(pageTimer);
  expect(first.storage.getItem(TIMER)).not.toBeNull();
  const remove = first.storage.removeItem;
  first.storage.removeItem = (key) => {
    if (key === TIMER) throw new Error('Synthetic removal denied');
    remove(key);
  };
  await first.view.click(`${strip} [data-timer]`);
  expect(world.finished).toEqual([A]);
  expect(first.view.text()).toContain('only in this tab');
  expect(first.storage.getItem(TIMER)).not.toBeNull();
});

it('invalid stored bytes confer no timer identity and trigger no command', async () => {
  const world = timerWorld();
  const storage = draftTab();
  storage.setItem(TIMER, '{malformed timer recovery');
  const first = await realm(world.fetch, storage, '/projects');
  expect(first.view.find(strip)?.textContent).toBe('Select task to time');
  expect(world.writes()).toEqual([]);
});
