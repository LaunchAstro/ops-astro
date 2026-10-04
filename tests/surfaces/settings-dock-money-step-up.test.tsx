// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable no-await-in-loop, require-await -- Sol's proof, kept as written */
import { act, useState } from 'react';
import { afterEach, expect, it } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore } from '../../apps/web/src/session/token.ts';
import { mount, settle, type Mounted } from './mount.tsx';

const views: Mounted[] = [];
afterEach(async () => {
  for (const view of views.splice(0)) await view.unmount();
  window.sessionStorage.clear();
  delete document.documentElement.dataset['themePreference'];
});
async function open(element: Parameters<typeof mount>[0]) {
  const view = await mount(element);
  views.push(view);
  return view;
}
const json = (value: unknown, status = 200) => Response.json(value, { status });

function Harness(props: {
  sessions: SessionStore;
  fetch: typeof globalThis.fetch;
  initial: string;
}) {
  const [path, navigate] = useState(props.initial);
  return (
    <App
      path={path}
      navigate={navigate}
      sessions={props.sessions}
      gotrueUrl="http://identity.invalid"
      apiOrigin=""
      fetch={props.fetch}
      storage={window.sessionStorage}
    />
  );
}

function common(at: string): Response | undefined {
  if (at.endsWith('/preference/read')) return json({ preferences: {} });
  if (at.endsWith('/session/person')) return json({ person: { name: 'Ada' } });
  if (at.endsWith('/person/list')) return json({ persons: [] });
  if (at.endsWith('/inbox/read')) return json({ inbox: [] });
  if (at.endsWith('/inbox/count')) return json({ owed: 0 });
  if (at.endsWith('/task/board')) return json({ tasks: [] });
  if (at.includes('/live')) return new Response(null, { status: 503 });
  return undefined;
}

// Sol OW-078.3 criterion correctness, retitled by what it proves; its body is Sol's.
it('the Settings dock offers the same money step-up as the full settings page', async () => {
  window.sessionStorage.setItem(
    'ops-astro.session',
    JSON.stringify({
      businessKey: 'alpha',
      email: 'ada@example.test',
      sessionId: 'tab-one',
    }),
  );
  let writes = 0;
  const fetch: typeof globalThis.fetch = async (input) => {
    const at = String(input);
    if (at.endsWith('/settings/read'))
      return json({ settings: [], planningCap: { limitMinor: 5000, currency: 'AUD', set: false } });
    if (at.endsWith('/session/capabilities'))
      return json({ grants: [{ collection: 'billing', action: 'decide' }] });
    if (at.endsWith('/budget/set_planning_cap')) {
      writes += 1;
      return json({ refused: true, code: 'STEP_UP_REQUIRED', names: [], fixes: [] }, 403);
    }
    if (at.endsWith('/account/sessions/list')) return json({ sessions: [] });
    return common(at) ?? json({});
  };
  const sessions = new SessionStore(window.sessionStorage);
  const page = await open(<Harness sessions={sessions} fetch={fetch} initial="/settings" />);
  await page.type('.content #settings-planning-cap', '75');
  await page.click('.content [data-settings="save-planning-cap"]');
  await settle();
  expect(page.find('.content [data-step-up="prompt"]')).not.toBeNull();
  await page.unmount();
  views.splice(views.indexOf(page), 1);
  const dock = await open(<Harness sessions={sessions} fetch={fetch} initial="/dashboard/" />);
  const tab = dock
    .all('button')
    .find((button) => button.textContent?.includes('Settings') && button.closest('main') === null);
  expect(tab).toBeDefined();
  await act(() => {
    (tab as HTMLButtonElement).click();
  });
  await settle();
  expect(dock.find('#settings-planning-cap')).not.toBeNull();
  await dock.type('#settings-planning-cap', '75');
  await dock.click('[data-settings="save-planning-cap"]');
  await settle();
  expect(writes).toBe(2);
  expect(dock.find('[data-step-up="prompt"]')).not.toBeNull();
});
