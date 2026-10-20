// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom

import { act } from 'react';
import { expect, it } from 'vitest';
import { ClientsScreen } from '../../apps/web/src/screens/Clients.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { hasIdentity } from '../../packages/core-commands/src/commands/requests.ts';
import { mount, settle } from '../surfaces/mount.tsx';
import { json } from './mp-2-1-support.tsx';

const input = '[data-client-add] input';
const add = '[data-client-add] button[type="submit"]';

it('a client named like an inherited property carries a valid operation identity', async () => {
  const sent: Record<string, unknown>[] = [];
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: (url, init) => {
      if (String(url).endsWith('/client/list'))
        return Promise.resolve(json({ ok: true, clients: [] }));
      const body: Record<string, unknown> = JSON.parse(String(init?.body));
      sent.push(body);
      // The envelope's actual identity check, applied to the JSON the form sent.
      return Promise.resolve(
        json(
          hasIdentity({ ...body, command: 'client.create' })
            ? { recordId: '11111111-1111-4111-8111-111111111111', revision: null, detail: {} }
            : { refused: true, code: 'OPERATION_ID_REQUIRED', names: [], fixes: [] },
          hasIdentity({ ...body, command: 'client.create' }) ? 200 : 400,
        ),
      );
    },
  });
  const page = await mount(<ClientsScreen client={client} grantKey="alpha:ada" />);
  await settle();
  await page.type(input, 'constructor');
  await page.click(add);
  await settle();
  expect(sent).toHaveLength(1);
  expect(sent[0]?.['name']).toBe('constructor');
  expect(hasIdentity({ ...sent[0], command: 'client.create' })).toBe(true);
});

it('a late create answer keeps a client name typed after it was sent', async () => {
  let answer: ((response: Response) => void) | undefined;
  const sent: Record<string, unknown>[] = [];
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: (url, init) => {
      if (String(url).endsWith('/client/list'))
        return Promise.resolve(json({ ok: true, clients: [] }));
      sent.push(JSON.parse(String(init?.body)));
      return new Promise<Response>((resolve) => {
        answer = resolve;
      });
    },
  });
  const page = await mount(<ClientsScreen client={client} grantKey="alpha:ada" />);
  await settle();
  await page.type(input, 'First Electrical');
  await page.click(add);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.['name']).toBe('First Electrical');
  // eslint-disable-next-line unicorn/no-array-callback-reference -- page.find takes a selector, not a callback
  expect(page.find(input)).toBeInstanceOf(HTMLInputElement);
  await page.type(input, 'Next Plumbing');
  // eslint-disable-next-line unicorn/no-array-callback-reference -- page.find takes a selector, not a callback
  const edited = page.find(input);
  if (!(edited instanceof HTMLInputElement)) throw new Error('the name field is missing');
  expect(edited.value).toBe('Next Plumbing');
  // eslint-disable-next-line require-await -- act flushes the answer's effects
  await act(async () => {
    if (answer === undefined) throw new Error('the create was not sent');
    answer(json({ recordId: '11111111-1111-4111-8111-111111111111', revision: null, detail: {} }));
  });
  await settle();
  // eslint-disable-next-line unicorn/no-array-callback-reference -- page.find takes a selector, not a callback
  const field = page.find(input);
  if (!(field instanceof HTMLInputElement)) throw new Error('the name field is missing');
  expect(field.value).toBe('Next Plumbing');
});
