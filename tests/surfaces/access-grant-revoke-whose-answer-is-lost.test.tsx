// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Settings ▸ Access: a grant revoke, confirmed as it already was before #1732,
// whose answer is lost after the server stored it. Pressed again, it goes
// under the same operation id, so the server replays what it stored; after a
// refusal, pressed again, it is a new operation.

import { afterEach, describe, expect, it } from 'vitest';
import { AccessScreen } from '../../apps/web/src/screens/Access.tsx';
import { idOf, raceServer, refused, stored } from '../web/write-race-support.tsx';
import { mount, settle, type Mounted } from './mount.tsx';
import { ADA, MIA, access } from './access-screen-world.tsx';

const live: Mounted[] = [];
afterEach(async () => {
  for (const view of live.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one screen at a time, as React's act needs
    await view.unmount();
  }
});

function world(refuse = false) {
  const record = { revoked: false };
  const api = raceServer((path) => {
    if (path === '/access/read') {
      const ada = record.revoked ? { ...ADA, grants: [] } : ADA;
      return { status: 200, body: access([ada, MIA]) };
    }
    if (refuse) return refused('ACCESS_LAST_MANAGER', 409);
    if (record.revoked) return refused('NOT_FOUND', 404);
    record.revoked = true;
    return stored(1);
  });
  return { record, ...api };
}

async function screen(api: ReturnType<typeof world>): Promise<Mounted> {
  const view = await mount(<AccessScreen client={api.client} grantKey="alpha:ada:0" />);
  live.push(view);
  await settle();
  await settle();
  return view;
}

async function revokeGrant(view: Mounted): Promise<void> {
  await view.click('[data-revoke-grant="g-ada-access"] button');
  await view.click('[data-confirm="revoke-grant"] [data-act="revoke"] button');
  await settle();
  await settle();
}

const revokes = (api: ReturnType<typeof world>) =>
  api.sent.filter((each) => each.path === '/access/revoke');

describe('a grant revoke pressed again', () => {
  it('after the server stored it with the answer lost is the same operation', async () => {
    const api = world();
    const view = await screen(api);
    api.fates.push('lose');
    await revokeGrant(view);
    expect(api.record.revoked).toBe(true);
    await revokeGrant(view);
    expect(revokes(api)).toHaveLength(2);
    expect(idOf(revokes(api), 1), 'the lost write goes again under its own id').toBe(
      idOf(revokes(api), 0),
    );
  });

  it('after a refusal is a new operation', async () => {
    const api = world(true);
    const view = await screen(api);
    await revokeGrant(view);
    await revokeGrant(view);
    expect(revokes(api)).toHaveLength(2);
    expect(idOf(revokes(api), 1)).not.toBe(idOf(revokes(api), 0));
  });
});
