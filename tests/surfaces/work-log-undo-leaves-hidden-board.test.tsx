// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable max-lines-per-function, require-await -- Sol's proof, kept as written */
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { Projects } from '../../apps/web/src/screens/Projects.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle, type Mounted } from './mount.tsx';

let view: Mounted | undefined;
afterEach(async () => {
  await view?.unmount();
  view = undefined;
  window.history.replaceState(null, '', '/');
  window.sessionStorage.clear();
});

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
const client = (businessKey: string, fetch: typeof globalThis.fetch): OperationsClient =>
  new OperationsClient({ origin: '', businessKey, signedIn: true, fetch });

// Sol OW-084.5 criterion correctness, retitled by what it proves; its body is Sol's.
it('undo on Work log does not change the hidden board or remove the Work log address', async () => {
  const task = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    key: 'TSK-1',
    title: 'A task',
    state: null,
    assignee: null,
    due: null,
    completedAt: null,
    revision: 1,
    rank: { number: null, calc: 'unranked' },
    stage: null,
    statePosition: 1,
    awaitingDecision: false,
    estimateMinutes: null,
    actualMinutes: 0,
    pageLink: null,
  };
  const api: typeof globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/live')) return new Response(null, { status: 503 });
    if (url.endsWith('/task/board')) return json({ tasks: [task], viewer: null });
    if (url.endsWith('/person/list')) return json({ persons: [] });
    if (url.endsWith('/inbox/read')) return json({ inbox: [] });
    if (url.endsWith('/inbox/count')) return json({ owed: 0 });
    if (url.endsWith('/task/ledger')) return json({ days: [], earlier: false });
    if (url.endsWith('/preference/read')) return json({ preferences: {} });
    throw new Error(`Unexpected request ${url}`);
  };
  window.history.replaceState(null, '', '/projects/');
  view = await mount(
    <Projects client={client('alpha', api)} grantKey="alpha:ada" navigate={() => {}} />,
  );
  await settle();
  const head = view.find('th[data-key="name"] button');
  expect(head).not.toBeNull();
  await act(async () => {
    (head as HTMLButtonElement).click();
  });
  expect(window.location.search).toContain('name');
  await view.click('#projects-tab-worklog');
  expect(window.location.hash).toBe('#worklog');
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }),
    );
  });
  expect(
    window.location.hash,
    'the hidden board handled undo and replaced the active tab address',
  ).toBe('#worklog');
});
