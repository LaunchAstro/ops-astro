// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// The Clients page and the dock's Clients panel draw the business's own
// clients from `client.list` (C32), and Add client sends `client.create`. No
// made-up client book is drawn by the application, so none reaches
// production.

import { afterEach, describe, expect, it } from 'vitest';
import { MADE_UP_BOOK } from '../../apps/web/src/data/clients-book.ts';
import { mount, settle, type Mounted } from '../surfaces/mount.tsx';
import { json, open } from './mp-2-1-support.tsx';
import { ClientsScreen } from '../../apps/web/src/screens/Clients.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';

const RIVERBEND = { clientId: '11111111-1111-4111-8111-111111111111', name: 'Riverbend Bakery' };
const CORAL = { clientId: '33333333-3333-4333-8333-333333333333', name: 'Coral Coast Yoga' };
const MADE = '55555555-5555-4555-8555-555555555555';

interface Sent {
  readonly to: string;
  readonly body: Readonly<Record<string, unknown>>;
}

/**
 * Alpha's server: its clients, and `client.create` answered by `create`
 * (applied, refused or never), adding the named client on success.
 */
function server(create: 'applied' | 'refused' | 'lost' = 'applied') {
  const sent: Sent[] = [];
  const clients = [RIVERBEND, CORAL];
  let lost = create === 'lost' ? 1 : 0;
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const to = String(url).replace(/^.*\/api\/b\/alpha/u, '');
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Sent['body'];
    sent.push({ to, body });
    if (to === '/client/list') return Promise.resolve(json({ ok: true, clients }));
    if (to === '/client/create') {
      if (create === 'refused')
        return Promise.resolve(
          json(
            {
              refused: true,
              code: 'SCOPE_NOT_GRANTED',
              names: [],
              fixes: ['Ask an owner for record:write.'],
            },
            403,
          ),
        );
      if (lost > 0) {
        lost -= 1;
        return Promise.reject(new TypeError('network down'));
      }
      if (!clients.some((each) => each.clientId === MADE))
        clients.push({ clientId: MADE, name: String(body['name']) });
      return Promise.resolve(json({ recordId: MADE, revision: null, detail: { clientId: MADE } }));
    }
    return new Promise<Response>(() => {});
  }) as unknown as typeof globalThis.fetch;
  return {
    fetch,
    sent,
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

const names = (page: Mounted): string[] =>
  page.all('.clbook__list .clbook__name').map((each) => each.textContent ?? '');

async function screen(api: ReturnType<typeof server>): Promise<Mounted> {
  const page = await mount(<ClientsScreen client={api.client} grantKey="alpha:ada" />);
  live.push(page);
  await settle();
  return page;
}

async function submit(page: Mounted): Promise<void> {
  await page.click('[data-client-add] button[type="submit"]');
  await settle();
}

async function add(page: Mounted, name: string): Promise<void> {
  await page.type('[data-client-add] input', name);
  await submit(page);
}

describe('the application draws the business’s own clients, never a made-up book', () => {
  it('the Clients page lists client.list’s clients A to Z and nothing made up', async () => {
    const api = server();
    const { view } = await open('/clients/', { fetch: api.fetch });
    live.push(view);
    await settle();
    expect(names(view)).toStrictEqual(['Coral Coast Yoga', 'Riverbend Bakery']);
    const text = view.find('.clbook')?.textContent ?? '';
    expect(text).not.toContain('Sample data');
    for (const made of MADE_UP_BOOK.clients) expect(text).not.toContain(made.name);
    expect(view.find('.clbook [data-provenance="mock"]')).toBeNull();
  });
});

describe('Add client', () => {
  it('creates the client through client.create, and the list then names it', async () => {
    const api = server();
    const page = await screen(api);
    await add(page, '  Northgate Plumbing ');
    const creates = api.sent.filter((one) => one.to === '/client/create');
    expect(creates).toHaveLength(1);
    expect(creates[0]?.body).toMatchObject({ name: 'Northgate Plumbing' });
    expect(names(page)).toStrictEqual([
      'Coral Coast Yoga',
      'Northgate Plumbing',
      'Riverbend Bakery',
    ]);
    expect((page.find('[data-client-add] input') as HTMLInputElement | null)?.value).toBe('');
  });

  it('a refusal is quoted in the server’s words and adds nothing', async () => {
    const api = server('refused');
    const page = await screen(api);
    await add(page, 'Northgate Plumbing');
    expect(page.find('[data-client-add] [role="alert"]')?.textContent).toContain(
      'Ask an owner for record:write.',
    );
    expect(names(page)).toStrictEqual(['Coral Coast Yoga', 'Riverbend Bakery']);
  });

  it('a create whose answer was lost is retried under the same operation id', async () => {
    const api = server('lost');
    const page = await screen(api);
    await add(page, 'Northgate Plumbing');
    await submit(page);
    const creates = api.sent.filter((one) => one.to === '/client/create');
    expect(creates).toHaveLength(2);
    expect(creates[1]?.body['operationId']).toBe(creates[0]?.body['operationId']);
    expect(names(page)).toContain('Northgate Plumbing');
  });
});
