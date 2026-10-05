// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
/* oxlint-disable require-await -- Sol's proof, kept as written */

import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { YouGroups } from '../../apps/web/src/screens/settings/you.tsx';
import { APPEARANCE_KEY } from '../../apps/web/src/appearance.ts';
import { mount, settle, type Mounted } from '../surfaces/mount.tsx';

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

// Sol OW-088.4 criterion correctness, retitled by what it proves; its body is Sol's.
it('a refused appearance save restores the rendered and cached theme to the reread value', async () => {
  let reads = 0;
  const api = client('alpha', async (url) => {
    if (url.endsWith('/preference/read')) {
      reads += 1;
      return json({ preferences: { appearance: 'light' } });
    }
    if (!url.endsWith('/preference/save')) throw new Error(`Unexpected route ${url}`);
    return json(
      { refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: ['Access revoked.'] },
      403,
    );
  });
  page = await mount(
    <YouGroups client={api} grantKey="alpha:ada" storage={window.sessionStorage} />,
  );
  await settle();
  await choose('Dark');
  await settle();
  expect(reads).toBe(2);
  expect(page.text()).toContain('SCOPE_NOT_GRANTED');
  expect(appearanceButton('Light').getAttribute('aria-pressed')).toBe('true');
  expect(
    document.documentElement.dataset['themePreference'],
    'The refused optimistic choice must not stay applied',
  ).toBe('light');
  expect(window.sessionStorage.getItem(APPEARANCE_KEY)).toBe('light');
});
