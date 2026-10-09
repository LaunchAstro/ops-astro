// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { A, START, timerWorld } from './task-bound-timer-support.tsx';
import { copied, realm } from './task-timer-recovery-support.tsx';
import { task } from './task-page-stub.tsx';

const TIMER = 'ops-astro.task-timer';
const STRIP = '[data-task-timer-strip]';
const PAGE = 'main [data-time-log-section] [data-timer]';
const RETRY = '[data-task-timer-retry]';
const ORIGINAL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NEWER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const noReply = (): void => {};

// The original request reaches the fixture's operation register, but its answer
// stays pending. A real checked read enriches the App-owned binding before reload.
async function pendingStart() {
  const world = timerWorld();
  let release = noReply;
  let held = false;
  const fetch: typeof globalThis.fetch = (url, init) => {
    const answer = world.fetch(url, init);
    if (!String(url).endsWith('/time/start') || held) return answer;
    held = true;
    return new Promise<Response>((resolve) => {
      release = () => {
        void answer.then(resolve);
      };
    });
  };
  const first = await realm(fetch);
  try {
    await first.view.click(PAGE);
    expect(held).toBe(true);
    const intent = world.writes()[0]!;
    await first.renderPath(`/task/${A}`);
    await first.tick();
    expect(first.view.find(STRIP)?.textContent).toContain('Alpha work');
    const storage = copied(first.storage);
    expect(storage.getItem(TIMER)).toContain('pending');
    expect(storage.getItem(TIMER)).not.toContain('Alpha work');
    expect(storage.getItem(TIMER)).not.toContain('Timer-A');
    await first.view.unmount();
    await first.act(release);
    return { world, storage, intent };
  } finally {
    release();
    await first.view.unmount();
  }
}

function projectsOnly(view: Awaited<ReturnType<typeof realm>>['view']): void {
  expect(view.find('main [data-task]')).toBeNull();
  expect(view.find('.dpanel[data-panel-id="task"]')).toBeNull();
  expect(view.find('[data-task-timer-retry]')).not.toBeNull();
}

async function replay(second: Awaited<ReturnType<typeof realm>>): Promise<void> {
  await second.view.click(RETRY);
  await second.tick();
  expect(second.view.find(RETRY)).toBeNull();
  expect(second.view.find(`${STRIP} [data-timer]`)?.hasAttribute('disabled')).toBe(false);
}

it('Projects-only exact Start retry retains the checked permitted timer title after reload', async () => {
  const { world, storage, intent } = await pendingStart();
  const readsBefore = world.sent.length;
  const second = await realm(world.fetch, storage, '/projects/');
  projectsOnly(second.view);
  expect(world.writes()).toEqual([intent]);
  expect(
    world.sent
      .slice(readsBefore)
      .some((request) => request.path === '/task/read' && request.body['recordId'] === A),
  ).toBe(true);
  expect(second.view.find(STRIP)?.textContent).toContain('Alpha work');
  await replay(second);
  expect(world.writes()).toEqual([intent, intent]);
  await expect
    .poll(async () => {
      await second.tick();
      return second.view.find(STRIP)?.textContent;
    })
    .toContain('Alpha work');
  expect(second.view.find('main [data-task]')).toBeNull();
  expect(second.view.find('.dpanel[data-panel-id="task"]')).toBeNull();
  expect(second.storage.getItem(TIMER)).not.toContain('Alpha work');
  await second.view.click(`${STRIP} [data-timer]`);
  expect(world.writes()[2]?.body).toMatchObject({ taskId: A, expectedEntryId: ORIGINAL });
  expect(world.finished).toEqual([A]);
});

it('a checked denial after rich recovery hides labels through Projects-only Start retry', async () => {
  const { world, storage, intent } = await pendingStart();
  const second = await realm(world.fetch, storage, '/projects/');
  expect(second.view.find(STRIP)?.textContent).toContain('Alpha work');
  world.deny();
  await second.renderPath(`/task/${A}`);
  await second.tick();
  expect(second.view.find('main [data-outcome="denied"]')).not.toBeNull();
  await second.renderPath('/projects/');
  projectsOnly(second.view);
  await replay(second);
  expect(world.writes()).toEqual([intent, intent]);
  expect(second.view.find(STRIP)?.textContent).toContain('Task unavailable');
  expect(second.view.find(STRIP)?.textContent).not.toContain('Alpha work');
  expect(second.view.find(STRIP)?.textContent).not.toContain('Timer-A');
  expect(second.storage.getItem(TIMER)).not.toContain('Alpha work');
  await second.view.click(`${STRIP} [data-timer]`);
  expect(world.writes()[2]?.body).toMatchObject({ taskId: A, expectedEntryId: ORIGINAL });
  expect(world.finished).toEqual([A]);
});

const response = (value: unknown): Response =>
  new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  });
function recoveryRead(
  world: ReturnType<typeof timerWorld>,
  entryId: string | null,
): typeof globalThis.fetch {
  return (url, init) => {
    if (!String(url).endsWith('/task/read')) return world.fetch(url, init);
    // Preserve fixture request accounting. Only the checked recovery DTO differs.
    void world.fetch(url, init);
    return Promise.resolve(
      response({
        ok: true,
        task: task({
          id: A,
          key: 'Timer-A',
          title: 'Alpha work',
          time:
            entryId === null
              ? null
              : {
                  entries: [],
                  running: { entryId, startedAt: START },
                  totalMinutes: 0,
                },
        }),
      }),
    );
  };
}

it('time-withheld recovery does not invent permitted timer labels from the retained Start', async () => {
  const { world, storage, intent } = await pendingStart();
  const second = await realm(recoveryRead(world, null), storage, '/projects/');
  projectsOnly(second.view);
  expect(second.view.find(STRIP)?.textContent).not.toContain('Alpha work');
  await replay(second);
  expect(world.writes()).toEqual([intent, intent]);
  expect(second.view.find(STRIP)?.textContent).toContain('Task unavailable');
  expect(second.view.find(STRIP)?.textContent).not.toContain('Alpha work');
  expect(second.view.find(STRIP)?.textContent).not.toContain('Timer-A');
  expect(second.view.find(STRIP)?.textContent).toContain('Task time could not be refreshed');
  await second.view.click(`${STRIP} [data-timer]`);
  expect(world.writes()[2]?.body).toMatchObject({ taskId: A, expectedEntryId: ORIGINAL });
});

it('historical Start replay preserves a newer checked running entry and its permitted title', async () => {
  const { world, storage, intent } = await pendingStart();
  const second = await realm(recoveryRead(world, NEWER), storage, '/projects/');
  projectsOnly(second.view);
  expect(second.view.find(STRIP)?.textContent).toContain('Alpha work');
  await replay(second);
  expect(world.writes()).toEqual([intent, intent]);
  expect(second.view.find(STRIP)?.textContent).toContain('Alpha work');
  expect(second.storage.getItem(TIMER)).toContain(NEWER);
  expect(second.storage.getItem(TIMER)).not.toContain(ORIGINAL);
  const elapsed = second.view.host.querySelector<HTMLElement>(`${STRIP} [data-task-timer-elapsed]`);
  expect(elapsed?.dataset['startedAt']).toBe(START);
  expect(world.finished).toEqual([]);
});
