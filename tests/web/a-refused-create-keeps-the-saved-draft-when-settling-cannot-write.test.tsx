// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom

import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { DraftPanel } from '../../apps/web/src/screens/task/DraftPanel.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { dropOtherDrafts } from '../../apps/web/src/screens/task/task-draft.ts';
import { store } from './draft-support.tsx';
import { mount, settle } from '../surfaces/mount.tsx';

afterEach(() => dropOtherDrafts(null, null));

it('a refused Create preserves the saved draft across a reload when settlement cannot write', async () => {
  const storage = store();
  const person = 'alpha:sol-refusal@example.test';
  const requests: string[] = [];
  let answer: ((response: Response) => void) | undefined;
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    newOperationId: () => '22222222-2222-4222-8222-000000000001',
    fetch: (input) => {
      if (String(input).endsWith('/task/create')) {
        requests.push(String(input));
        return new Promise<Response>((resolve) => {
          answer = resolve;
        });
      }
      return Promise.resolve(Response.json({ ok: true, persons: [] }));
    },
  });
  const panel = () => (
    <DraftPanel
      client={client}
      storage={storage}
      person={person}
      scope={{ clientId: null, from: 'Projects' }}
      onCreated={() => {
        throw new Error('The server refused Create');
      }}
      onClose={() => {}}
      hold={() => () => true}
    />
  );
  const first = await mount(panel());
  await settle();
  await first.type('#panel-draft-name', 'Renew the domain');
  await first.click('[data-draft="create"]');
  expect(requests).toHaveLength(1);
  const write = storage.setItem.bind(storage);
  storage.setItem = () => {
    throw new DOMException('full', 'QuotaExceededError');
  };
  await act(async () => {
    answer?.(
      Response.json(
        { refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] },
        { status: 403 },
      ),
    );
    await Promise.resolve();
  });
  await settle();
  expect(first.find('[data-draft="create"]')?.textContent).toBe('Create task');
  await first.unmount();
  storage.setItem = write;
  dropOtherDrafts(null, null);
  const reloaded = await mount(panel());
  await settle();
  const name = reloaded.find('#panel-draft-name');
  expect(name).toBeInstanceOf(HTMLInputElement);
  expect(name instanceof HTMLInputElement ? name.value : null).toBe('Renew the domain');
});
