// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The Work log drawn in a dock panel reads its search from the panel's own
// address and writes it nowhere else: the page behind the panel keeps its own
// `q`, and the panel never inherits it.

import { expect, it } from 'vitest';
import { Projects } from '../../apps/web/src/screens/Projects.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount } from '../surfaces/mount.tsx';
import { FIRST, pinZone, server, tick } from './work-log-stand-in.tsx';

pinZone();

const opened: string[] = [];

const panel = (fetch: typeof globalThis.fetch, address: string) => (
  <Projects
    client={new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch })}
    grantKey="alpha:owner"
    navigate={(path) => opened.push(path)}
    address={address}
    inPanel
  />
);

it('a panel Work log neither reads nor rewrites the search of the page behind it', async () => {
  window.history.replaceState(null, '', '/clients/?q=main-search');
  const api = server([{ body: FIRST }, { body: FIRST }]);
  const view = await mount(panel(api.fetch, '/projects/#worklog'));
  await tick();
  expect(api.asked[0]).toEqual({ timeZone: 'Australia/Brisbane', before: null });
  expect((view.find('input[type="search"]') as HTMLInputElement).value).toBe('');
  await view.type('input[type="search"]', 'panel-search');
  await tick();
  expect(window.location.pathname).toBe('/clients/');
  expect(window.location.search).toBe('?q=main-search');
  expect(api.asked[1]).toMatchObject({ query: 'panel search' });
  await view.unmount();
});

it("a panel Work log opens searched when the panel's own address carries q", async () => {
  window.history.replaceState(null, '', '/clients/');
  const api = server([{ body: FIRST }]);
  const view = await mount(panel(api.fetch, '/projects/?q=hinge#worklog'));
  await tick();
  expect((view.find('input[type="search"]') as HTMLInputElement).value).toBe('hinge');
  expect(api.asked[0]).toMatchObject({ query: 'hinge' });
  await view.unmount();
});
