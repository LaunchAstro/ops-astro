// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
/* oxlint-disable max-lines-per-function, require-await -- Sol's proof, kept as written */

import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { YouGroups } from '../../apps/web/src/screens/settings/you.tsx';
import { mount, settle, type Mounted } from '../surfaces/mount.tsx';
import { adaToken, call, read, usePreferencesWorld } from '../api/preferences-world.ts';

// A real API and fresh database. Only request delivery is delayed, as a network can delay it.
usePreferencesWorld('solow088');

function gate() {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
}

let page: Mounted | null = null;
afterEach(async () => {
  await page?.unmount();
  page = null;
  delete document.documentElement.dataset['themePreference'];
  delete document.documentElement.dataset['themeFade'];
});

function button(label: string): HTMLButtonElement {
  const found = page
    ?.all('[data-pref="appearance"] button')
    .find((node) => node.textContent === label);
  if (!(found instanceof HTMLButtonElement)) throw new Error(`Missing ${label}`);
  return found;
}

// Sol OW-088.3 criterion 5, retitled by what it proves; its body is Sol's.
it('reordered preference saves through the real API persist the last enabled appearance choice', async () => {
  const dark = gate();
  const light = gate();
  const pending: Promise<Response>[] = [];
  const sent: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const saving = url.endsWith('/preference/save');
    if (!saving && !url.endsWith('/preference/read')) throw new Error(`Unexpected route ${url}`);
    if (saving) {
      const value = String(body['value']);
      sent.push(value);
      await (value === 'dark' ? dark.held : light.held);
    }
    const answer = await call(saving ? 'preference.save' : 'preference.read', body, adaToken);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  // Track each browser call through its response without relying on elapsed time.
  const tracked: typeof globalThis.fetch = (input, init) => {
    const response = fetch(input, init);
    pending.push(response);
    return response;
  };
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: tracked,
  });
  page = await mount(<YouGroups client={client} grantKey="alpha:ada" storage={null} />);
  await act(async () => {
    await Promise.all(pending);
  });
  await act(async () => {
    button('Dark').click();
  });
  const acceptsSecond = !button('Light').disabled;
  await act(async () => {
    button('Light').click();
  });
  // Light reaches the real handler before Dark whenever both controls were enabled.
  light.release();
  if (acceptsSecond)
    await act(async () => {
      await pending[2];
    });
  dark.release();
  await act(async () => {
    // A corrected implementation may queue the second write after the first response.
    for (let index = 0; index < pending.length; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- completing one response may enqueue the next request
      await pending[index];
    }
  });
  await settle();
  expect(sent).toStrictEqual(acceptsSecond ? ['dark', 'light'] : ['dark']);
  const expected = acceptsSecond ? 'light' : 'dark';
  expect(button(acceptsSecond ? 'Light' : 'Dark').getAttribute('aria-pressed')).toBe('true');
  expect(
    (await read(adaToken))['appearance'],
    'Stored preference must agree with the last enabled choice',
  ).toBe(expected);
});
