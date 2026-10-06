// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
/* oxlint-disable max-lines-per-function, no-promise-executor-return, require-await -- Sol's proof, kept as written */

import { expect, it } from 'vitest';
import { act } from 'react';
import { OperationsScreen } from '../../apps/web/src/screens/Operations.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { createWorld } from '../acceptance/world.ts';
import { asBrowser } from '../support/sign-in.ts';
import { mount, settle, type Mounted } from '../surfaces/mount.tsx';

async function waitFor(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100; turn += 1) {
    if (condition()) return;
    // eslint-disable-next-line no-await-in-loop -- polling waits for the previous database request.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  expect(condition(), 'the database-backed screen must finish its request').toBe(true);
}

// Sol OW-083.8 criterion 5, retitled by what it proves; its body is Sol's.
it('retrying an incident after a lost committed response records it once', async () => {
  const world = await createWorld('sol_ow083_retry');
  let page: Mounted | undefined;
  try {
    const results: number[] = [];
    const client = new OperationsClient({
      origin: 'http://api.test',
      businessKey: 'alpha',
      signedIn: true,
      fetch: asBrowser(world.ada.token, async (url, init) => {
        const response = await world.api.fetch(new Request(String(url), init));
        if (String(url).endsWith('/privacy/record_incident')) {
          results.push(response.status);
          if (results.length === 1 && response.ok)
            throw new TypeError('Response lost after commit');
        }
        return response;
      }),
    });
    page = await mount(<OperationsScreen client={client} grantKey="alpha:ada" />);
    const form = '[data-section="record-incident"]';
    await waitFor(
      () => page?.find(`${form} textarea`) !== null && page?.find(`${form} textarea`) !== undefined,
    );
    await page.type(`${form} [data-field="whatHappened"] textarea`, 'Sol proof single incident');
    await page.type(
      `${form} [data-field="foundAt"] input`,
      new Date(Date.now() - 60_000).toISOString(),
    );
    await page.type(`${form} [data-field="foundBy"] input`, 'Ada');
    await page.type(`${form} [data-field="affected"] textarea`, 'One client');
    await page.click(`${form} [data-kind="contact"] [role="checkbox"]`);
    await page.click(`${form} button[type="submit"]`);
    await waitFor(() => page?.text().includes('Response lost after commit') === true);
    expect(results).toEqual([200]);
    expect(page.text()).toContain('Response lost after commit');
    const count = async () =>
      world.db.app.withBusiness(world.alpha, async (tx) => {
        const rows = await tx.query<{ n: number }>(
          "select count(*)::int as n from public.privacy_incidents where what_happened = 'Sol proof single incident'",
        );
        return rows[0]?.n;
      });
    expect(await count(), 'the first incident committed before the response was lost').toBe(1);
    await page.click(`${form} button[type="submit"]`);
    await waitFor(() => results.length === 2);
    await settle();
    expect(results).toEqual([200, 200]);
    expect(await count(), 'retry of the same form must replay the committed effect').toBe(1);
  } finally {
    await page?.unmount();
    await world.close();
  }
}, 60_000);
