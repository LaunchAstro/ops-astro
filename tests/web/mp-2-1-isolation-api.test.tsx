// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-2-1 isolation, business to business, against the real boundary and a
// fresh Postgres. The held-address switch names a business only where the
// person holds a grant there, and the only thing that decides that is the
// server: the application's probe is `session.capabilities` under the held
// business's prefix, sent with the new bearer through the mounted API.
//
// Two businesses, Alpha and Bravo, and four made-up people: one with a grant in
// both, one in Alpha only, one in Bravo only, and one who is a member of Bravo
// with no grant there. Only the first is offered a switch, in either direction.
// And an agent working under a live delegation from an Alpha person: it is
// offered neither business, because a delegation never lends its person's reach.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { heldAddressOffer } from '../../apps/web/src/held-address.tsx';
import { authorised, post, tokenFor, type ApiFixture } from '../api/fixture.ts';
import { agentPath, createControls } from '../api/controls-fixture.ts';
import { grantTo, type Member } from '../commands/fixture.ts';
import {
  insertActor,
  insertBusiness,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from '../identity/fixture.ts';
import type { Database } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();

/** A login for `subject` in `businessId`, mapped to a new person there, with or without a grant. */
async function enrolAs(
  database: Database,
  businessId: string,
  subject: string,
  grant: boolean,
): Promise<void> {
  await database.withBusiness(businessId, async (tx) => {
    const personId = await insertPerson(tx, subject);
    const actorId = await insertActor(tx, personId);
    await insertMembership(tx, personId);
    const loginId = await insertLogin(tx, subject);
    await insertMapping(tx, loginId, personId, actorId);
    const member: Member = { personId, actorId, presented: { provider: 'supabase', subject } };
    if (grant) await grantTo(tx, member, 'read');
  });
}

describe.skipIf(serverUrl === undefined)('MP-2-1 isolation', () => {
  let fixture: ApiFixture;
  let api: Hono;
  let agentSubject: string;
  /** The live delegation's credential, which the agent presents beside its login. */
  let delegation: string;
  const subjects = {
    both: `both-${randomUUID()}`,
    alphaOnly: `alpha-only-${randomUUID()}`,
    bravoOnly: `bravo-only-${randomUUID()}`,
    bravoNoGrant: `bravo-no-grant-${randomUUID()}`,
  };

  beforeAll(async () => {
    const controls = await createControls('mp_2_1_isolation');
    ({ fixture, api } = controls);
    // A live delegation: an Alpha person approves a task and the agent picks it up.
    const task = await controls.createTask('made-up delegated task');
    const reservation = await controls.approve(await controls.propose(task.id, task.revision));
    const picked = await controls.pickup(reservation);
    expect(typeof picked['credential']).toBe('string');
    delegation = String(picked['credential']);
    agentSubject = fixture.agent.subject;
    const bravo = await insertBusiness(fixture.db.app, 'bravo');
    await enrolAs(fixture.db.app, fixture.business, subjects.both, true);
    await enrolAs(fixture.db.app, bravo, subjects.both, true);
    await enrolAs(fixture.db.app, fixture.business, subjects.alphaOnly, true);
    await enrolAs(fixture.db.app, bravo, subjects.bravoOnly, true);
    await enrolAs(fixture.db.app, fixture.business, subjects.bravoNoGrant, true);
    await enrolAs(fixture.db.app, bravo, subjects.bravoNoGrant, false);
  }, 120_000);

  afterAll(async () => await fixture?.drop());

  const through = ((url: string | URL, init?: RequestInit) =>
    api.fetch(new Request(`http://api.test${String(url)}`, init))) as typeof fetch;

  async function offer(subject: string, heldIn: string, signedInTo: string, held?: string) {
    // An agent's probe carries its live delegation on every call, as the agent's own client does.
    const fetch = (
      held === undefined
        ? through
        : async (url: string | URL, init?: RequestInit) => {
            const headers = new Headers(init?.headers);
            headers.set('x-agent-delegation', held);
            return await through(url, { ...init, headers });
          }
    ) as typeof globalThis.fetch;
    return await heldAddressOffer({
      held: { address: '/task/TSK-1', businessKey: heldIn, code: 'AUTH_SESSION_EXPIRED' },
      next: { token: await tokenFor(subject), businessKey: signedInTo, email: 'x@example.test' },
      apiOrigin: '',
      fetch,
    });
  }

  it('offers the switch to a person holding a grant in the held business, both ways', async () => {
    expect(await offer(subjects.both, 'bravo', 'alpha')).toEqual({
      kind: 'switch',
      businessKey: 'bravo',
      address: '/task/TSK-1',
    });
    expect(await offer(subjects.both, 'alpha', 'bravo')).toEqual({
      kind: 'switch',
      businessKey: 'alpha',
      address: '/task/TSK-1',
    });
  });

  it('names no business to a person with no login there', async () => {
    expect(await offer(subjects.alphaOnly, 'bravo', 'alpha')).toEqual({ kind: 'unnamed' });
    expect(await offer(subjects.bravoOnly, 'alpha', 'bravo')).toEqual({ kind: 'unnamed' });
  });

  it('names no business to a member who holds no grant there', async () => {
    expect(await offer(subjects.bravoNoGrant, 'bravo', 'alpha')).toEqual({ kind: 'unnamed' });
  });

  it('names no business to an agent under a live delegation from an Alpha person', async () => {
    // The delegation is live and the bearer with it is answered on the agent's own route,
    // so an unnamed offer below is the delegation lending nothing, not a dead credential.
    const live = await post(
      api,
      agentPath('session.capabilities'),
      { operationId: randomUUID() },
      { ...authorised(await tokenFor(agentSubject)), 'x-agent-delegation': delegation },
    );
    expect(live.status).toBe(200);
    for (const held of [undefined, delegation]) {
      // eslint-disable-next-line no-await-in-loop -- bearer alone, then with the delegation
      expect(await offer(agentSubject, 'alpha', 'bravo', held)).toEqual({ kind: 'unnamed' });
      // eslint-disable-next-line no-await-in-loop -- bearer alone, then with the delegation
      expect(await offer(agentSubject, 'bravo', 'alpha', held)).toEqual({ kind: 'unnamed' });
    }
  });

  it('names no business for one that does not exist, the same as one the person is not in', async () => {
    expect(await offer(subjects.both, 'charlie', 'alpha')).toEqual({ kind: 'unnamed' });
  });
});
