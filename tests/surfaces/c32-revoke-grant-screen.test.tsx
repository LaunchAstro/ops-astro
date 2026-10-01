// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C32's revocation on Settings ▸ Access: each live grant `access.read` lists
// for a person is its own Revoke act, sent as `access.revoke` by that grant's
// id once it is confirmed, then the list is reread. A grant over a client the
// read does not list is named as that, never by its identifier. A refusal is
// shown in the server's words and changes nothing. The world is
// `access-screen-world.tsx`'s.

import { afterEach, describe, expect, it } from 'vitest';
import { settle } from './mount.tsx';
import {
  ACME,
  ADA,
  MIA,
  access,
  json,
  open,
  refusal,
  rowOf,
  server,
  unmountAll,
} from './access-screen-world.tsx';

afterEach(unmountAll);

const ON_ACME = { collection: 'task', action: 'read', scope: { kind: 'party', id: ACME.clientId } };
const HIDDEN = 'c-not-listed-9f2e';
const MIA_HOLDING = {
  ...MIA,
  permissions: [ON_ACME],
  grants: [
    { grantId: 'g-mia-acme', ...ON_ACME },
    {
      grantId: 'g-mia-hidden',
      collection: 'task',
      action: 'comment',
      scope: { kind: 'party', id: HIDDEN },
    },
  ],
};
const MIA_AFTER = { ...MIA, permissions: [], grants: [MIA_HOLDING.grants[1]] };

describe('C32 revoke one grant on Settings ▸ Access', () => {
  it('C32 revoke grant: each grant is its own act, confirmed, sent by its id, then the list reread', async () => {
    const api = server([json(access([ADA, MIA_HOLDING])), json(access([ADA, MIA_AFTER]))]);
    const view = await open(api.fetch);
    await view.click('[data-revoke-grant="g-mia-acme"] button');
    expect(api.commands()).toEqual([]);
    expect(view.find('[data-confirm="revoke-grant"]')?.textContent).toContain(ACME.name);
    await view.click('[data-confirm="revoke-grant"] [data-act="revoke"] button');
    await settle();
    await settle();
    expect(api.commands()).toEqual([
      {
        url: '/api/b/alpha/access/revoke',
        body: expect.objectContaining({ grantId: 'g-mia-acme' }) as unknown,
      },
    ]);
    expect(api.calls.filter((call) => call.url.endsWith('/access/read'))).toHaveLength(2);
    expect(view.find('[data-revoke-grant="g-mia-acme"]')).toBeNull();
    expect(view.find('[data-access-outcome]')?.textContent).toContain(MIA.name);
  });

  it('C32 revoke grant can be called off: nothing is sent', async () => {
    const api = server([json(access([ADA, MIA_HOLDING]))]);
    const view = await open(api.fetch);
    await view.click('[data-revoke-grant="g-mia-acme"] button');
    await view.click('[data-confirm="revoke-grant"] [data-act="keep"] button');
    expect(view.find('[data-confirm="revoke-grant"]')).toBeNull();
    expect(api.commands()).toEqual([]);
  });

  it('C32 revoke grant: a grant over a client the read does not list is named as that, never by its id', async () => {
    const api = server([json(access([ADA, MIA_HOLDING]))]);
    const view = await open(api.fetch);
    expect(view.find('[data-revoke-grant="g-mia-hidden"]')).not.toBeNull();
    expect(rowOf(view, MIA.personId)).toContain('a client not listed here');
    expect(view.find('[data-screen="access"]')?.textContent).not.toContain(HIDDEN);
  });

  it("C32 revoke grant: a refusal is shown in the server's words and the list is not reread", async () => {
    const api = server([json(access([ADA, MIA_HOLDING]))], () => refusal('SCOPE_NOT_GRANTED', 403));
    const view = await open(api.fetch);
    await view.click('[data-revoke-grant="g-mia-acme"] button');
    await view.click('[data-confirm="revoke-grant"] [data-act="revoke"] button');
    await settle();
    await settle();
    expect(view.find('[data-access-outcome]')?.textContent).toContain('SCOPE_NOT_GRANTED');
    expect(api.calls.filter((call) => call.url.endsWith('/access/read'))).toHaveLength(1);
    expect(view.find('[data-revoke-grant="g-mia-acme"]')).not.toBeNull();
  });
});
