// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// One operation id per thing the person meant to do (the web-writes rule). A
// save whose answer never arrived may have been stored, so pressing it again
// unchanged is the same intent and carries the same id: the server replays a
// stored success instead of storing it twice. Any answer, or a changed value,
// is a new intent with a new id.

import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { SettingsScreen } from '../../apps/web/src/screens/Settings.tsx';
import { YouGroups } from '../../apps/web/src/screens/settings/you.tsx';
import { mount, settle } from './mount.tsx';
import { fourEyesWorld, tick, writesOf } from './settings-four-eyes-world.tsx';

const idOf = (body: Record<string, unknown> | undefined): unknown => body?.['operationId'];

it('a settings save retried after a lost answer keeps its operation id; a new value does not', async () => {
  window.sessionStorage.clear();
  const world = fourEyesWorld({ value: 500, revision: 7 });
  const page = await mount(
    <SettingsScreen
      client={world.client()}
      grantKey="alpha:ada:0"
      storage={window.sessionStorage}
    />,
  );
  try {
    await tick();
    world.write = 'lost';
    await page.type('#settings-four-eyes', '1200');
    await page.click('[data-settings="save-four-eyes"]');
    await tick();
    await page.click('[data-settings="save-four-eyes"]');
    await tick();
    await page.type('#settings-four-eyes', '1300');
    await page.click('[data-settings="save-four-eyes"]');
    await tick();

    const [lost, retry, next] = writesOf(world).map((call) => idOf(call.body));
    expect(typeof lost).toBe('string');
    expect(retry, 'the retry of the same save minted a new operation id').toBe(lost);
    expect(next).not.toBe(lost);
  } finally {
    await page.unmount();
  }
});

it('a settings retry after a reread carries the revision its first attempt was sent at', async () => {
  window.sessionStorage.clear();
  const world = fourEyesWorld({ value: 500, revision: 7 });
  const page = await mount(
    <SettingsScreen
      client={world.client()}
      grantKey="alpha:ada:0"
      storage={window.sessionStorage}
    />,
  );
  try {
    await tick();
    // Stored at revision 7, its answer lost: the server now holds 1200 at revision 8.
    world.write = 'stored-lost';
    await page.type('#settings-four-eyes', '1200');
    await page.click('[data-settings="save-four-eyes"]');
    await tick();
    // Another save on the page answers and rereads, so the row on screen is at revision 8.
    await page.click('[data-settings="save-sign-off"]');
    await tick();
    expect(world.sent.filter((call) => call.at.endsWith('/settings/read')).length).toBeGreaterThan(
      1,
    );
    await page.click('[data-settings="save-four-eyes"]');
    await tick();
    const [lost, retry] = writesOf(world)
      .filter((call) => call.at.endsWith('/set_four_eyes_threshold'))
      .map((call) => call.body);
    expect(retry?.['operationId']).toBe(lost?.['operationId']);
    expect(
      retry?.['expectedRevision'],
      'the retry moved to the reread revision, so the register would refuse it as reused',
    ).toBe(7);
  } finally {
    await page.unmount();
  }
});

it('a preference choice repeated after a lost answer keeps its operation id; another choice does not', async () => {
  const saves: Record<string, unknown>[] = [];
  let lose = true;
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: ((url: string | URL, init?: RequestInit) => {
      const at = String(url);
      if (at.endsWith('/preference/save')) {
        saves.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        if (lose) {
          lose = false;
          return Promise.reject(new TypeError('Failed to fetch'));
        }
        return Promise.resolve(Response.json({ recordId: 'pref', revision: 1, detail: {} }));
      }
      return Promise.resolve(Response.json({ preferences: { appearance: 'light' } }));
    }) as typeof globalThis.fetch,
  });
  const page = await mount(<YouGroups client={client} grantKey="alpha:ada:0" storage={null} />);
  try {
    await settle();
    await page.click('[data-pref="appearance"] button:nth-child(2)');
    await settle();
    await page.click('[data-pref="appearance"] button:nth-child(2)');
    await settle();
    await page.click('[data-pref="appearance"] button:nth-child(3)');
    await settle();
    const [lost, retry, next] = saves.map((body) => idOf(body));
    expect(typeof lost).toBe('string');
    expect(retry, 'the repeated choice minted a new operation id').toBe(lost);
    expect(next).not.toBe(lost);
  } finally {
    await page.unmount();
    delete document.documentElement.dataset['themePreference'];
    delete document.documentElement.dataset['themeFade'];
  }
});
