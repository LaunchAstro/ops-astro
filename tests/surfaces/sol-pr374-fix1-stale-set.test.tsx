// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { KeysPanel } from '../../apps/web/src/screens/settings/keys.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { generateSealingPair } from '../../packages/core-records/src/custody/index.ts';
import { grantTo } from '../commands/fixture.ts';
import { createControls } from '../api/controls-fixture.ts';
import { mount } from './mount.tsx';
import { act } from 'react';

const tick = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
};

it('Sol proof, criterion 5: stale Set does not overwrite a key replaced by another administrator', async () => {
  const controls = await createControls('sol374', { custody: generateSealingPair('sol374').key });
  let page: Awaited<ReturnType<typeof mount>> | undefined;
  try {
    await controls.fixture.db.app.withBusiness(controls.fixture.business, async (tx) => {
      await grantTo(
        tx,
        controls.manager,
        'manage',
        { kind: 'business', id: null },
        false,
        'custody',
      );
      await grantTo(
        tx,
        controls.reader,
        'manage',
        { kind: 'business', id: null },
        false,
        'custody',
      );
    });
    const first = await controls.asPerson('secret.set', { name: 'stale.key', value: 'old-canary' });
    expect(first.status).toBe(200);
    const fetcher: typeof fetch = async (url, init) => {
      const command = String(url).split('/').slice(-2).join('.');
      const body: unknown = JSON.parse(String(init?.body));
      if (typeof body !== 'object' || body === null) throw new Error('invalid test body');
      const answer = await controls.asPerson(command, body as Record<string, unknown>);
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      });
    };
    page = await mount(
      <KeysPanel
        client={
          new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch: fetcher })
        }
      />,
    );
    await tick();
    expect(page.find('[data-secret="stale.key"]')).not.toBeNull();
    await page.type('#key-name', 'stale.key');
    await page.type('[data-settings="key-value"]', 'my-stale-canary');
    const second = await controls.asPerson(
      'secret.set',
      {
        name: 'stale.key',
        value: 'new-canary',
        expectedRevision: first.body['revision'],
      },
      controls.reader,
    );
    expect(second.status).toBe(200);
    await page.click('button[type="submit"]');
    await tick();
    const listing = await controls.asPerson('secret.list', {});
    expect(listing.body['secrets']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'stale.key',
          state: 'set',
          revision: second.body['revision'],
        }),
      ]),
    );
  } finally {
    await page?.unmount();
    await controls.drop();
  }
}, 120_000);
