// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
/* oxlint-disable no-promise-executor-return -- Sol's proof, kept as written */
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

// Sol OW-096.2 criterion 5, retitled by what it proves; its body is Sol's.
it('Enter cannot open a hit from the previous query while the new query is pending', async () => {
  let requests = 0;
  const source = client('alpha', async () => {
    requests += 1;
    if (requests === 1) return json({ ok: true, hits: [hit] });
    return await new Promise<Response>(() => {});
  });
  const opened: string[] = [];
  page = await mount(
    <SearchPalette client={source} onOpen={(path) => opened.push(path)} onClose={() => {}} />,
  );
  await page.type('input', 'private');
  await pause();
  expect(page.text()).toContain(hit.title);
  await page.type('input', 'unrelated');
  await pause();
  expect(requests).toBe(2);
  await act(() => {
    page
      ?.find('input')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  expect(opened).toEqual([]);
});
