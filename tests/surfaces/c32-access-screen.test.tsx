// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C32 and C58 on Settings ▸ Access, through the real App and client against a
// stand-in API that answers the bodies `access.read` and the three access
// commands return (`tests/reads/effective-permissions.test.ts` pins them on
// the real server).
//
// The screen draws Team, Clients and Agents from one read, each with what it
// may do now; gives a person one permission, over the whole business or one
// client; ends a person's access in one confirmed act; and revokes an agent's
// delegation by its own id. What reaches another business or another client
// is the server's to refuse (`C32 isolation`, `C58 isolation`); what this
// screen owes is to ask only its own business, to name a client only from the
// read's own records, and to draw a refusal as a refusal, never as an empty list.

import { afterEach, describe, expect, it } from 'vitest';
import { settle } from './mount.tsx';
import {
  ACME,
  ADA,
  BOLT,
  CLEO,
  MIA,
  MIA_ON_ACME,
  access,
  choose,
  json,
  open,
  refusal,
  rowOf,
  server,
  unmountAll,
} from './access-screen-world.tsx';

afterEach(unmountAll);

describe('C32 Settings ▸ Access', () => {
  it('C32 access screen: Team, Clients and Agents from one person list, each with its preview', async () => {
    const api = server([json(access([ADA, MIA]))]);
    const view = await open(api.fetch);
    expect(view.find('[data-screen="access"]')).not.toBeNull();
    expect(view.find('[data-access="team"]')?.textContent).toContain('Ada Alpha');
    expect(view.find('[data-access="team"]')?.textContent).toContain('Mia Alpha');
    expect(view.find('[data-access="clients"]')?.textContent).toContain('Cleo Client');
    expect(view.find('[data-access="agents"]')?.textContent).toContain('Draft the weekly report');
    // Each preview says what the grant check would allow, over what.
    expect(rowOf(view, ADA.personId)).toContain('access:manage');
    expect(rowOf(view, ADA.personId)).toContain('whole business');
    expect(rowOf(view, CLEO.personId)).toContain('task:read');
    expect(rowOf(view, CLEO.personId)).toContain(ACME.name);
    expect(rowOf(view, MIA.personId)).toContain('No permission');
    // One read, of its own business only.
    expect(api.calls.map((call) => call.url)).toEqual(['/api/b/alpha/access/read']);
  });

  it('C32 owner check: give a teammate one client, and their preview shows that client only', async () => {
    const api = server([json(access([ADA, MIA])), json(access([ADA, MIA_ON_ACME]))]);
    const view = await open(api.fetch);
    await choose(view, 'holder', MIA.name);
    await choose(view, 'key', 'task:read');
    await choose(view, 'scope', ACME.name);
    await view.click('[data-access="give"] button[type="submit"]');
    await settle();
    await settle();
    expect(api.commands()).toEqual([
      {
        url: '/api/b/alpha/access/grant',
        body: expect.objectContaining({
          holderId: MIA.personId,
          collection: 'task',
          action: 'read',
          clientId: ACME.clientId,
        }) as unknown,
      },
    ]);
    // The preview is the server's, reread after the grant.
    expect(rowOf(view, MIA.personId)).toContain(ACME.name);
    expect(rowOf(view, MIA.personId)).not.toContain(BOLT.name);
    expect(rowOf(view, MIA.personId)).not.toContain('whole business');
  });
});

describe('C32 grants and revocations on Settings ▸ Access', () => {
  it('C32 whole business: a grant with no client sends a null client', async () => {
    const api = server([json(access([ADA, MIA]))]);
    const view = await open(api.fetch);
    await choose(view, 'holder', MIA.name);
    await choose(view, 'key', 'task:comment');
    await view.click('[data-access="give"] button[type="submit"]');
    await settle();
    expect(api.commands()[0]?.body).toEqual(
      expect.objectContaining({
        holderId: MIA.personId,
        collection: 'task',
        action: 'comment',
        clientId: null,
      }),
    );
  });

  it('C32 refusal shown: a refused grant keeps the server code, and the preview is not changed', async () => {
    const api = server([json(access([ADA, MIA]))], () => refusal('SCOPE_NOT_GRANTED', 403));
    const view = await open(api.fetch);
    await choose(view, 'holder', MIA.name);
    await choose(view, 'key', 'task:read');
    await choose(view, 'scope', ACME.name);
    await view.click('[data-access="give"] button[type="submit"]');
    await settle();
    expect(view.find('[data-access-outcome]')?.textContent).toContain('SCOPE_NOT_GRANTED');
    expect(rowOf(view, MIA.personId)).toContain('No permission');
  });
});

describe('C32 isolation on the Access screen', () => {
  it('C32 isolation (screen): a denied read is drawn denied, never as an empty list', async () => {
    const api = server([refusal('SCOPE_NOT_GRANTED', 403)]);
    const view = await open(api.fetch);
    expect(view.find('[data-outcome="denied"]')).not.toBeNull();
    expect(view.text()).toContain('SCOPE_NOT_GRANTED');
    expect(view.find('[data-access="team"]')).toBeNull();
    expect(view.find('[data-access="give"]')).toBeNull();
  });

  it('C32 isolation (screen): a scope naming no client of this read is never given a name', async () => {
    const stray = {
      ...MIA,
      permissions: [
        { collection: 'task', action: 'read', scope: { kind: 'party', id: 'c-elsewhere' } },
      ],
    };
    const api = server([json(access([ADA, stray]))]);
    const view = await open(api.fetch);
    expect(rowOf(view, MIA.personId)).toContain('a client not listed here');
    expect(rowOf(view, MIA.personId)).not.toContain('c-elsewhere');
  });
});

describe('C32 agents on Settings ▸ Access', () => {
  it('C32 agents: a live delegation is revoked by its own id, then the list is reread', async () => {
    const api = server([json(access([ADA, MIA])), json(access([ADA, MIA], []))]);
    const view = await open(api.fetch);
    expect(view.find('[data-agent="d-1"]')?.closest('tr')?.textContent).toContain('task:write');
    await view.click('[data-revoke="d-1"]');
    await settle();
    await settle();
    expect(api.commands()).toEqual([
      {
        url: '/api/b/alpha/delegation/revoke',
        body: expect.objectContaining({ delegationId: 'd-1' }) as unknown,
      },
    ]);
    expect(view.find('[data-agent="d-1"]')).toBeNull();
  });
});
