// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { Root } from 'react-dom/client';
import { draftTab } from './projects-draft-app-support.tsx';
import { timerWorld, A, START } from './task-bound-timer-support.tsx';
import { copied, realm } from './task-timer-recovery-support.tsx';

const TIMER = 'ops-astro.task-timer';
const active: { root: Root; host: HTMLDivElement; act: typeof import('react').act }[] = [];
afterEach(async () => {
  await Promise.all(
    active.splice(0).map(async (page) => {
      await page.act(() => page.root.unmount());
      page.host.remove();
    }),
  );
});

async function serverApp(fetch: typeof globalThis.fetch, storage: Storage) {
  vi.resetModules();
  const [{ act, createElement }, { renderToString }, { hydrateRoot }, { App }, { SessionStore }] =
    await Promise.all([
      import('react'),
      import('react-dom/server'),
      import('react-dom/client'),
      import('../../apps/web/src/App.tsx'),
      import('../../apps/web/src/session/token.ts'),
    ]);
  const element = createElement(App, {
    path: '/projects/',
    navigate: () => {},
    sessions: new SessionStore(storage),
    gotrueUrl: 'http://gotrue.test',
    apiOrigin: '',
    fetch,
    storage,
  });
  const html = renderToString(element);
  return {
    html,
    act,
    hydrate: async () => {
      const host = document.createElement('div');
      host.innerHTML = html;
      document.body.append(host);
      const errors: unknown[] = [];
      await act(async () => {
        const root = hydrateRoot(host, element, {
          onRecoverableError: (error) => errors.push(error),
        });
        active.push({ root, host, act });
        await Promise.resolve();
      });
      return { host, errors };
    },
  };
}

it('the actual signed-in App server-renders a neutral timer without issuing requests', async () => {
  const world = timerWorld();
  const page = await serverApp(world.fetch, draftTab());
  expect(page.html).toContain('class="shell"');
  expect(page.html).toContain('Select task to time');
  expect(page.html).not.toContain('data-task-timer-retry');
  expect(world.sent).toEqual([]);
});

it('server HTML hides restored custody, then hydration keeps the original guarded Stop for explicit retry', async () => {
  const world = timerWorld();
  const first = await realm(world.fetch);
  await first.view.click('main [data-time-log-section] [data-timer]');
  world.loseStop();
  await first.view.click('[data-task-timer-strip] [data-timer]');
  const original = world.writes().at(-1)!;
  expect(original.path).toBe('/time/stop');
  expect(original.body['expectedEntryId']).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  expect(world.finished).toEqual([A]);
  const storage = copied(first.storage);
  const retained = storage.getItem(TIMER);
  await first.view.unmount();
  world.deny();
  const before = world.writes().length;
  const page = await serverApp(world.fetch, storage);
  expect(page.html).toContain('Select task to time');
  for (const privateValue of [A, START, String(original.body['operationId']), 'Alpha work']) {
    expect(page.html).not.toContain(privateValue);
  }
  expect(page.html).not.toContain('data-task-timer-retry');
  expect(page.html).not.toContain('data-running="true"');
  expect(storage.getItem(TIMER)).toBe(retained);
  expect(world.writes()).toHaveLength(before);
  const hydrated = await page.hydrate();
  expect(hydrated.errors).toEqual([]);
  expect(hydrated.host.textContent).toContain('Timer outcome unknown');
  expect(hydrated.host.querySelector('[data-task-timer-strip]')?.textContent).not.toContain(
    'Alpha work',
  );
  expect(world.writes()).toHaveLength(before);
  const held = JSON.parse(storage.getItem(TIMER)!);
  expect(held.attempt.operationId).toBe(original.body['operationId']);
  expect(held.attempt.payload).toEqual({
    taskId: original.body['taskId'],
    expectedEntryId: original.body['expectedEntryId'],
  });
  const retry = hydrated.host.querySelector<HTMLButtonElement>('[data-task-timer-retry]');
  expect(retry).not.toBeNull();
  await page.act(async () => {
    retry!.click();
    await Promise.resolve();
  });
  expect(world.writes()).toHaveLength(before + 1);
  expect(world.writes().at(-1)).toEqual(original);
  expect(world.finished).toEqual([A]);
});
