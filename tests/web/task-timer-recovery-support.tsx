// SPDX-License-Identifier: AGPL-3.0-only
import { vi } from 'vitest';
import { draftTab } from './projects-draft-app-support.tsx';
import { store } from './draft-support.tsx';

/** Only JSON crosses this boundary; each application/session/controller module is new. */
export function copied(storage: Storage): Storage {
  const next = store();
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null) next.setItem(key, storage.getItem(key)!);
  }
  return next;
}

export async function realm(
  fetch: typeof globalThis.fetch,
  storage = draftTab(),
  path = '/task/Timer-A',
) {
  vi.resetModules();
  const [{ act, createElement }, { App }, { SessionStore }, { mount }, { tick }] =
    await Promise.all([
      import('react'),
      import('../../apps/web/src/App.tsx'),
      import('../../apps/web/src/session/token.ts'),
      import('../surfaces/mount.tsx'),
      import('./task-page-stub.tsx'),
    ]);
  const sessions = new SessionStore(storage);
  const props = {
    path,
    navigate: () => {},
    sessions,
    gotrueUrl: 'http://gotrue.test',
    apiOrigin: '',
    fetch,
    storage,
  };
  const view = await mount(createElement(App, props));
  await tick();
  return {
    act,
    view,
    storage,
    sessions,
    tick,
    renderPath: (nextPath: string) => view.render(createElement(App, { ...props, path: nextPath })),
    renderFetch: (nextFetch: typeof globalThis.fetch) =>
      view.render(createElement(App, { ...props, fetch: nextFetch })),
  };
}
