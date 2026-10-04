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

// Sol OW-088.2 criterion 5, retitled by what it proves; its body is Sol's.
it('a delayed initial preference read cannot replace a successfully saved appearance', async () => {
  const initial = deferred<Response>();
  let stored = 'system';
  const writes: unknown[] = [];
  const api = client('alpha', async (url, body) => {
    if (url.endsWith('/preference/read')) return await initial.promise;
    if (!url.endsWith('/preference/save')) throw new Error(`Unexpected route ${url}`);
    writes.push(body);
    stored = String(body['value']);
    return json({ recordId: null, revision: null });
  });
  page = await mount(
    <YouGroups client={api} grantKey="alpha:ada" storage={window.sessionStorage} />,
  );
  if (appearanceButton('Dark').disabled) {
    await act(async () => {
      initial.resolve(json({ preferences: { appearance: 'system' } }));
    });
    await settle();
  }
  await choose('Dark');
  await settle();
  expect(writes).toHaveLength(1);
  expect(stored).toBe('dark');
  expect(appearanceButton('Dark').getAttribute('aria-pressed')).toBe('true');
  await act(async () => {
    initial.resolve(json({ preferences: { appearance: 'system' } }));
  });
  await settle();
  expect(
    appearanceButton('Dark').getAttribute('aria-pressed'),
    'An older read must not undo the completed save',
  ).toBe('true');
});
