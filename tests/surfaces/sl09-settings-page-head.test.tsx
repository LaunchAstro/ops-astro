// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Settings ▸ Access and Settings ▸ Telemetry wear the shell's page header
// (DS-COMP-3), which already names the page. The page keeps its one lead line
// and draws no second title, and never the task page's record header (`.tpr`),
// which belongs to a task (UI-POLISH look sweep of batch/2a).

import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore } from '../../apps/web/src/session/token.ts';
import { mount, settle, type Mounted } from './mount.tsx';

const SESSION = { token: 'the-live-token', businessKey: 'alpha', email: 'ada@alpha.local' };

const live: Mounted[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((view) => view.unmount()));
});

async function open(path: string): Promise<Mounted> {
  const held = new Map([['ops-astro.session', JSON.stringify(SESSION)]]);
  const sessions = new SessionStore({
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => {
      held.set(key, value);
    },
    removeItem: (key) => {
      held.delete(key);
    },
  });
  // The read's answer does not matter here: the page head draws in every state.
  const fetch = (() =>
    Promise.resolve(new Response('{}', { status: 503 }))) as unknown as typeof globalThis.fetch;
  const view = await mount(
    <App
      path={path}
      navigate={() => {
        // One address for the whole case.
      }}
      sessions={sessions}
      gotrueUrl="http://identity.invalid"
      apiOrigin=""
      fetch={fetch}
      storage={window.sessionStorage}
    />,
  );
  live.push(view);
  await settle();
  await settle();
  return view;
}

const titlesNamed = (view: Mounted, name: string): number =>
  view.all('h1, h2').filter((heading) => heading.textContent?.trim() === name).length;

describe('SL09 settings pages wear the shell page header only', () => {
  it.each([
    ['access', '/settings/access/', 'Access', 'Who may do what in alpha'],
    ['telemetry', '/settings/telemetry/', 'Telemetry', 'Service health for alpha'],
  ])(
    'Settings ▸ %s names the page once, in the page header, and keeps its lead',
    async (screen, path, title, lead) => {
      const view = await open(path);
      const page = view.find(`[data-screen="${screen}"]`);
      expect(page).not.toBeNull();
      expect(view.find('.topbar h1')?.textContent).toBe(title);
      expect(titlesNamed(view, title)).toBe(1);
      expect(page?.querySelector('.tpr, .tpr__title')).toBeNull();
      expect(page?.querySelector('[data-page-lead]')?.textContent).toContain(lead);
    },
  );
});
