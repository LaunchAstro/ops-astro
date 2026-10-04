// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
/* oxlint-disable consistent-function-scoping, max-lines-per-function -- Sol's proof, kept as written */
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { useLayoutStore } from '../../apps/web/src/shell/layout-store.ts';
import { mount } from '../surfaces/mount.tsx';
import { adaToken, call, read, usePreferencesWorld } from '../api/preferences-world.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

function deferred() {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'layout write ordering, real API and Postgres',
  () => {
    usePreferencesWorld('solow096');
    // Sol OW-096.3 criterion 5, retitled by what it proves; its body is Sol's.
    it('two rail releases keep the latest width when the first request arrives last', async () => {
      const completions = deferred();
      const secondApplied = deferred();
      const release = deferred();
      const statuses: number[] = [];
      let sent = 0;
      const through: typeof globalThis.fetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        if (!('preference' in body)) return new Response(JSON.stringify({ preferences: {} }));
        const ordinal = ++sent;
        if (ordinal === 1) await release.promise;
        // Only request arrival is controlled; auth, grants, mutation and storage are real.
        const answer = await call('preference.save', body, adaToken);
        statuses.push(answer.status);
        if (ordinal === 2) secondApplied.resolve();
        if (statuses.length === 2) completions.resolve();
        return new Response(JSON.stringify(answer.body), { status: answer.status });
      };
      const client = new OperationsClient({
        origin: '',
        businessKey: 'alpha',
        signedIn: true,
        fetch: through,
      });
      const session = { businessKey: 'alpha', email: 'ada@example.test' };
      function Layout() {
        const store = useLayoutStore(client, session, null);
        return (
          <>
            <output>{String(store.layout['rail.width'])}</output>
            <button id="first" onClick={() => store.save('rail.width', 300)}>
              First release
            </button>
            <button id="last" onClick={() => store.save('rail.width', 400)}>
              Last release
            </button>
          </>
        );
      }
      const page = await mount(<Layout />);
      try {
        await page.click('#first');
        await page.click('#last');
        expect(page.find('output')?.textContent).toBe('400');
        // If the second request was sent concurrently, commit it before the first
        // arrives. A serial implementation has sent only the held first request.
        if (sent === 2)
          await act(async () => {
            await secondApplied.promise;
          });
        release.resolve();
        await act(async () => {
          await completions.promise;
        });
        expect(statuses).toEqual([200, 200]);
        expect((await read(adaToken))['rail.width']).toBe(400);
      } finally {
        release.resolve();
        await page.unmount();
      }
    });
  },
);
