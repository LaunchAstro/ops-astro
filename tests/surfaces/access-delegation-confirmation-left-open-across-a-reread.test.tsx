// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Revoke delegation is confirmed before it is sent. A confirmation left open
// while another write reads the list again, which no longer lists the
// delegation (another tab revoked it), must not send a revoke for it.

import { afterEach, expect, it } from 'vitest';
import { AccessScreen } from '../../apps/web/src/screens/Access.tsx';
import { raceServer, refused, stored } from '../web/write-race-support.tsx';
import { mount, settle, type Mounted } from './mount.tsx';
import { ACME, ADA, AGENT, MIA, access, choose } from './access-screen-world.tsx';

let view: Mounted | undefined;
afterEach(async () => {
  await view?.unmount();
  view = undefined;
});

const CONFIRM = '[data-confirm="revoke-delegation"]';

it('a delegation confirmation left open across a reread that drops it sends no revoke', async () => {
  const record = { agents: [AGENT] as unknown[], reads: 0 };
  const api = raceServer((path) => {
    if (path === '/access/read') {
      record.reads += 1;
      return { status: 200, body: access([ADA, MIA], record.agents) };
    }
    if (path === '/delegation/revoke') return refused('NOT_FOUND', 404);
    return stored(1);
  });
  view = await mount(<AccessScreen client={api.client} grantKey="alpha:ada:0" />);
  await settle();
  await settle();
  await choose(view, 'privacy-client', ACME.name);
  await view.click('[data-revoke="d-1"] button');
  // Another tab revokes it; the privacy save here reads the list again.
  record.agents = [];
  await view.click('[data-privacy-setting="health"] button[role="switch"]');
  await view.click('[data-access="client-privacy"] button[type="submit"]');
  await settle();
  await settle();
  expect(record.reads).toBe(2);
  expect(view.find('[data-revoke="d-1"]')).toBeNull();
  if (view.find(CONFIRM) !== null) {
    await view.click(`${CONFIRM} [data-act="revoke"] button`);
    await settle();
    await settle();
  }
  expect(
    api.sent.filter((each) => each.path === '/delegation/revoke'),
    'the reread no longer lists the delegation the confirmation names',
  ).toHaveLength(0);
});
