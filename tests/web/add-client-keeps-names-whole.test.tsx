// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// Add client takes any name a client may have: one that matches a property
// every object inherits still goes out with its own operation id. And a
// create that answers late clears the name it sent, never one typed since.

import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { ClientsScreen } from '../../apps/web/src/screens/Clients.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle, type Mounted } from '../surfaces/mount.tsx';
import { json } from './mp-2-1-support.tsx';

const MADE = '55555555-5555-4555-8555-555555555555';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Alpha's book, with every `client.create` answered when the test says. */
function server() {
  const sent: Readonly<Record<string, unknown>>[] = [];
  const held: (() => void)[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const to = String(url).replace(/^.*\/api\/b\/alpha/u, '');
    if (to === '/client/list') return Promise.resolve(json({ ok: true, clients: [] }));
    if (to === '/client/create') {
      sent.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
      return new Promise<Response>((resolve) => {
        held.push(() => {
          resolve(json({ recordId: MADE, revision: null, detail: { clientId: MADE } }));
        });
      });
    }
    return new Promise<Response>(() => {});
  }) as unknown as typeof globalThis.fetch;
  return {
    sent,
    answer: async () => {
      await act(async () => {
        for (const each of held.splice(0)) each();
        await Promise.resolve();
      });
      await settle();
      await settle();
    },
    client: new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch }),
  };
}

const live: Mounted[] = [];
afterEach(async () => {
  for (const page of live.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one act() scope at a time
    await page.unmount();
  }
});

async function screen(api: ReturnType<typeof server>): Promise<Mounted> {
  const page = await mount(<ClientsScreen client={api.client} grantKey="alpha:ada" />);
  live.push(page);
  await settle();
  return page;
}

const typed = (page: Mounted): string =>
  (page.find('[data-client-add] input') as HTMLInputElement | null)?.value ?? '';

describe('Add client keeps names whole', () => {
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'a client named %s goes out with an operation id of its own',
    async (name) => {
      const api = server();
      const page = await screen(api);
      await page.type('[data-client-add] input', name);
      await page.click('[data-client-add] button[type="submit"]');
      expect(api.sent).toHaveLength(1);
      expect(api.sent[0]?.['name']).toBe(name);
      expect(String(api.sent[0]?.['operationId'])).toMatch(UUID);
    },
  );

  it('a create that answers after another name is typed leaves that name in the box', async () => {
    const api = server();
    const page = await screen(api);
    await page.type('[data-client-add] input', 'Northgate Plumbing');
    await page.click('[data-client-add] button[type="submit"]');
    await page.type('[data-client-add] input', 'Coral Coast Yoga');
    await api.answer();
    expect(typed(page)).toBe('Coral Coast Yoga');
  });

  it('a create that answers with the sent name still in the box clears it', async () => {
    const api = server();
    const page = await screen(api);
    await page.type('[data-client-add] input', '  Northgate Plumbing ');
    await page.click('[data-client-add] button[type="submit"]');
    await api.answer();
    expect(typed(page)).toBe('');
  });
});
