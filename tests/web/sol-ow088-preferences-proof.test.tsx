// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
/* oxlint-disable require-await -- Sol's proof, kept as written */

import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { YouGroups } from '../../apps/web/src/screens/settings/you.tsx';
import { mount, settle, type Mounted } from '../surfaces/mount.tsx';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function client(
  businessKey: string,
  route: (url: string, body: Record<string, unknown>) => Promise<Response>,
) {
  const fetch: typeof globalThis.fetch = async (input, init) =>
    await route(String(input), JSON.parse(String(init?.body ?? '{}')));
  return new OperationsClient({ origin: '', businessKey, signedIn: true, fetch });
}

let page: Mounted | null = null;
afterEach(async () => {
  await page?.unmount();
  page = null;
  window.sessionStorage.clear();
  delete document.documentElement.dataset['themePreference'];
  delete document.documentElement.dataset['themeFade'];
});

function appearanceButton(label: string): HTMLButtonElement {
  const button = page
    ?.all('[data-pref="appearance"] button')
    .find((node) => node.textContent === label);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing appearance button ${label}`);
  return button;
}

async function choose(label: string) {
  await act(async () => {
    appearanceButton(label).click();
  });
}

it("Sol proof, criterion 2: business to business, saving while the new reader loads must not expose the old reader's dismissed tips", async () => {
  const pending = deferred<Response>();
  const alpha = client('alpha', async (url) => {
    if (!url.endsWith('/preference/read')) throw new Error(`Unexpected Alpha route ${url}`);
    return json({
      preferences: { 'tips.dismissed': { 'alpha-private-one': 1, 'alpha-private-two': 1 } },
    });
  });
  const betaWrites: unknown[] = [];
  const beta = client('beta', async (url, body) => {
    if (url.endsWith('/preference/read')) return await pending.promise;
    if (!url.endsWith('/preference/save')) throw new Error(`Unexpected Beta route ${url}`);
    betaWrites.push(body);
    return json({ recordId: null, revision: null });
  });
  page = await mount(<YouGroups client={alpha} grantKey="alpha:ada" storage={null} />);
  await settle();
  expect(page.text()).toContain('Bring back 2 dismissed tips');
  await page.render(<YouGroups client={beta} grantKey="beta:ada" storage={null} />);
  expect(page.text()).not.toContain('Bring back 2 dismissed tips');
  const maySave = !appearanceButton('Dark').disabled;
  await choose('Dark');
  await settle();
  expect(betaWrites).toHaveLength(maySave ? 1 : 0);
  expect(page.text(), "No Beta read has supplied Alpha's personal tip count").not.toContain(
    'Bring back 2 dismissed tips',
  );
});
