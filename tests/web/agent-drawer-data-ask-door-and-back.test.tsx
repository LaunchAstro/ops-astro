// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
/* oxlint-disable no-await-in-loop, unicorn/prefer-dom-node-dataset -- Sol's proof, kept as written */

import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore, type Session } from '../../apps/web/src/session/token.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';

const MIA: Session = {
  businessKey: 'alpha',
  email: 'mia@alpha.local',
  sessionId: 'mia-session',
};
const pending: typeof fetch = () => new Promise<Response>(() => {});
const pages: Mounted[] = [];
afterEach(async () => {
  for (const page of pages.splice(0)) await page.unmount();
});

function memory(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => {
      values.clear();
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

async function app(): Promise<Mounted> {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1920 });
  const storage = memory();
  const sessions = new SessionStore(storage);
  sessions.set(MIA);
  const page = await mount(
    <App
      path="/projects/"
      navigate={() => {}}
      sessions={sessions}
      gotrueUrl="http://identity.invalid"
      apiOrigin=""
      fetch={pending}
      storage={storage}
    />,
  );
  pages.push(page);
  return page;
}

// Sol OW-081.1 criterion correctness, retitled by what it proves; its body is Sol's.
it('the shipped Agent tab opens through a data-ask door', async () => {
  const page = await app();
  expect(page.find('.dock__tab[data-panel="ai"]')).not.toBeNull();
  const ask = document.createElement('button');
  ask.setAttribute('data-ask', 'What changed?');
  const content = page.find('.content');
  if (content === null) throw new Error('no content');
  content.append(ask);
  await act(() => {
    ask.click();
  });
  expect(page.find('[data-panel-id="ai"]')).not.toBeNull();
});

// Sol OW-081.2 criterion correctness, retitled by what it proves; its body is Sol's.
it('back restores the live Agent drawer without a fake registration', async () => {
  const page = await app();
  await page.click('.dock__tab[data-panel="ai"]');
  expect(page.find('[data-panel-id="ai"]')).not.toBeNull();
  const settings = page.find('.dock__tab[data-panel="settings"]');
  if (settings === null) throw new Error('no settings tab');
  await act(() => {
    settings.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
  });
  expect(page.find('[data-panel-id="ai"]')).not.toBeNull();
  expect(page.find('[data-panel-id="settings"]')).not.toBeNull();
  await page.click('[data-panel-id="settings"] [data-act="back"]');
  expect(page.find('[data-panel-id="settings"]')).toBeNull();
  expect(page.find('[data-panel-id="ai"]')).not.toBeNull();
});
