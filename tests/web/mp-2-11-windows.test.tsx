// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-2-11 This business: the conversation and retention windows (CS-2.13) as
// two more rows of the built settings screen, with the same revision and
// refusal handling as the four-eyes and client sign-off rows. The commands'
// own rules (whole days, the conversation window at least seven days and never
// past the retention window, settings:manage) are the server's, proved in
// tests/commands; these prove what the page sends and draws.

import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { SettingsScreen } from '../../apps/web/src/screens/Settings.tsx';
import { mount, type Mounted } from '../surfaces/mount.tsx';

const pause = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

const tick = async (): Promise<void> => {
  await act(async () => {
    await pause();
    await pause();
    await pause();
  });
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Sent {
  readonly at: string;
  readonly body: Record<string, unknown>;
}

/** The API the screen meets; `stale` answers every window write VERSION_STALE. */
function server(stale = false) {
  const sent: Sent[] = [];
  const route = (at: string): Response => {
    if (at.endsWith('/settings/read'))
      return json({
        ok: true,
        settings: [
          { key: 'conversation_window_days', value: 30, revision: 2, updatedAt: null },
          { key: 'retention_window_days', value: 365, revision: 5, updatedAt: null },
        ],
      });
    if (at.endsWith('/session/capabilities'))
      return json({
        ok: true,
        personId: 'p-ada',
        businessKey: 'alpha',
        grants: [{ collection: 'settings', action: 'manage' }],
      });
    if (stale && at.includes('_window'))
      return json(
        { refused: true, code: 'VERSION_STALE', names: ['expectedRevision'], fixes: ['Reread.'] },
        409,
      );
    return json({ ok: true, recordId: 'r-1', revision: 9 });
  };
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    sent.push({ at, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    return Promise.resolve(route(at));
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

const open = async (fetch: typeof globalThis.fetch): Promise<Mounted> => {
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', token: 'tok', fetch });
  const page = await mount(
    <SettingsScreen client={client} grantKey="alpha:ada" storage={window.sessionStorage} />,
  );
  await tick();
  return page;
};

const windowWrites = (api: ReturnType<typeof server>): readonly Sent[] =>
  api.sent.filter((call) => call.at.includes('_window'));

let page: Mounted | null = null;
afterEach(async () => {
  await page?.unmount();
  page = null;
  window.sessionStorage.clear();
});

it('MP-2-11 business rows: each window saves through its own command with the revision the read carried', async () => {
  const api = server();
  page = await open(api.fetch);
  expect(page.find('[data-settings="conversation-value"]')?.textContent).toContain('30');
  expect(page.find('[data-settings="retention-value"]')?.textContent).toContain('365');

  await page.type('#settings-conversation', '14');
  await page.click('[data-settings="save-conversation"]');
  await tick();
  await page.type('#settings-retention', '400');
  await page.click('[data-settings="save-retention"]');
  await tick();

  const writes = windowWrites(api);
  expect(writes.map((call) => call.at)).toEqual([
    '/api/b/alpha/settings/set_conversation_window',
    '/api/b/alpha/settings/set_retention_window',
  ]);
  expect(writes[0]?.body).toMatchObject({ value: 14, expectedRevision: 2 });
  expect(writes[1]?.body).toMatchObject({ value: 400, expectedRevision: 5 });
});

it('MP-2-11 business rows: a stale revision on a window is drawn as the conflict, with the draft', async () => {
  const api = server(true);
  page = await open(api.fetch);
  await page.type('#settings-retention', '90');
  await page.click('[data-settings="save-retention"]');
  await tick();
  const conflict = page.find('[data-settings="conflict"]');
  expect(conflict).not.toBeNull();
  expect(conflict?.textContent).toContain('90');
  expect(page.find('[data-settings="confirm-retention"]')).not.toBeNull();
});

it('MP-2-11 business rows: a window that is not a whole number of days is refused on the page, and nothing is sent', async () => {
  const api = server();
  page = await open(api.fetch);
  await page.type('#settings-conversation', '2.5');
  await page.click('[data-settings="save-conversation"]');
  await tick();
  expect(windowWrites(api)).toEqual([]);
  expect(page.find('[data-settings="refusal"]')?.textContent).toContain('whole number of days');
});
