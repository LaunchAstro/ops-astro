// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
/* oxlint-disable no-promise-executor-return, require-await, unicorn/consistent-function-scoping -- Sol's proof, kept as written */
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { SearchPalette } from '../../apps/web/src/search.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';

let page: Mounted | undefined;
afterEach(async () => {
  await page?.unmount();
});
const hit = { id: 'alpha-private-id', key: 'A-1', title: 'Alpha private canary' };
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
const pause = async () => {
  await act(async () => {
    await new Promise((done) => setTimeout(done, 230));
  });
};
function client(businessKey: string, fetch: typeof globalThis.fetch) {
  return new OperationsClient({ origin: '', businessKey, signedIn: true, fetch });
}

it('Sol proof, criterion 2: business to business search results disappear when the business client changes', async () => {
  const alpha = client('alpha', async () => json({ ok: true, hits: [hit] }));
  const calls: string[] = [];
  const bravo = client('bravo', (input) => {
    calls.push(String(input));
    return new Promise<Response>(() => {});
  });
  const drawn = (source: OperationsClient) => (
    <SearchPalette client={source} onOpen={() => {}} onClose={() => {}} />
  );
  page = await mount(drawn(alpha));
  await page.type('input', 'private');
  await pause();
  expect(page.text()).toContain(hit.title);
  // App.tsx keeps this component mounted across onSwitch and replaces client.
  await page.render(drawn(bravo));
  await pause();
  expect(calls).toEqual(['/api/b/bravo/task/search']);
  expect(page.text()).not.toContain(hit.title);
  expect(page.text()).not.toContain(hit.key);
});
