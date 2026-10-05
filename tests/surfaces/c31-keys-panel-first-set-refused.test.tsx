// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// SEC-374-R3 M1: a name the panel's list does not hold is set with the
// expect-absent form (`expectedRevision: 0`), so a key another administrator
// created after the panel read is refused, not silently replaced.
import { act } from 'react';
import { expect, it } from 'vitest';
import { KeysPanel } from '../../apps/web/src/screens/settings/keys.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { generateSealingPair } from '../../packages/core-records/src/custody/index.ts';
import { grantTo } from '../commands/fixture.ts';
import { createControls } from '../api/controls-fixture.ts';
import { mount } from './mount.tsx';

type Controls = Awaited<ReturnType<typeof createControls>>;

type Page = Awaited<ReturnType<typeof mount>>;

/** Flush until `selector` is drawn, or five seconds pass: the API answers at the database's pace. */
async function drawn(page: Page, selector: string): Promise<void> {
  for (let waited = 0; waited < 5000 && page.all(selector).length === 0; waited += 30) {
    // eslint-disable-next-line no-await-in-loop -- one flush at a time, until it is drawn
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 30);
      });
    });
  }
}

/** The panel's requests, answered by the API as the manager. */
function fetcherFor(controls: Controls): typeof fetch {
  return async (url, init) => {
    const command = String(url).split('/').slice(-2).join('.');
    const body: unknown = JSON.parse(String(init?.body));
    if (typeof body !== 'object' || body === null) throw new Error('invalid test body');
    const answer = await controls.asPerson(command, body as Record<string, unknown>);
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

async function grantBoth(controls: Controls): Promise<void> {
  await controls.fixture.db.app.withBusiness(controls.fixture.business, async (tx) => {
    for (const member of [controls.manager, controls.reader]) {
      // eslint-disable-next-line no-await-in-loop -- two grants in one transaction
      await grantTo(tx, member, 'manage', { kind: 'business', id: null }, false, 'custody');
    }
  });
}

it('first Set does not overwrite a key another administrator created after the panel read', async () => {
  const controls = await createControls('absent374', {
    custody: generateSealingPair('absent374').key,
  });
  let page: Page | undefined;
  try {
    await grantBoth(controls);
    const client = new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      signedIn: true,
      fetch: fetcherFor(controls),
    });
    page = await mount(<KeysPanel client={client} />);
    await drawn(page, '[data-settings="key-rows"]');
    expect(page.find('[data-settings="key-rows"]')).not.toBeNull();
    expect(page.find('[data-secret="late.key"]')).toBeNull();
    await page.type('#key-name', 'late.key');
    await page.type('[data-settings="key-value"]', 'my-first-canary');
    const other = await controls.asPerson(
      'secret.set',
      { name: 'late.key', value: 'other-admin-canary' },
      controls.reader,
    );
    expect(other.status).toBe(200);
    await page.click('button[type="submit"]');
    await drawn(page, '[data-settings="keys-refusal"]');
    expect(page.find('[data-settings="keys-refusal"]')?.textContent).toContain('VERSION_STALE');
    // The reread after the refusal draws the other administrator's row.
    await drawn(page, '[data-secret="late.key"]');
    expect(page.find('[data-secret="late.key"][data-state="set"]')).not.toBeNull();
    const listing = await controls.asPerson('secret.list', {});
    expect(listing.body['secrets']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'late.key',
          state: 'set',
          revision: other.body['revision'],
        }),
      ]),
    );
  } finally {
    await page?.unmount();
    await controls.drop();
  }
}, 120_000);
