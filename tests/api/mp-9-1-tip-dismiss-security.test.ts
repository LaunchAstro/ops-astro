// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-9-1's security lines, through the page kit's one tip dismiss: a section
// tip's dismissal is `preference.dismiss_tip` (CS-9.1), which writes the
// caller's own `tips.dismissed` under the self-scoped `preference:write` and
// is never audited. Each test is named after its ticket line: the isolation
// case crosses another business, another client of this business and an
// agent under a live delegation; a dismissal naming another person is refused
// and writes nothing; a caller without `preference:write` (a person with no
// membership, an agent) is refused; an applied dismissal and a read add no
// audit event. The world is MP-2-11's preference world.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { dismissedTipCount, tipKey } from '../../packages/core-wire/src/tips.ts';
import { createClient } from '../../packages/core-records/src/index.ts';
import {
  insertActor,
  insertBusiness,
  insertLogin,
  insertMapping,
  insertPerson,
} from '../identity/fixture.ts';
import { enrol, grantTo, installSpine } from '../commands/fixture.ts';
import { tokenFor } from './fixture.ts';
import {
  ada,
  adaToken,
  ben,
  benToken,
  c,
  call,
  dismiss,
  dismissedOf,
  expectNoCanary,
  fixture,
  rowsOf,
  usePreferencesWorld,
} from './preferences-world.ts';

const serverUrl = databaseUrlFromEnvironment();

/** A section tip on a built page, as the page kit's SectionTip names it. */
const TIP = { page: 'agency:inbox', tip: 'inbox-owed' } as const;
const OTHER = { page: 'agency:inbox', tip: 'inbox-groups' } as const;

/** Every audit event under an actor, whatever its command. */
const auditsOf = async (actorId: string): Promise<number> => {
  const [row] = await fixture.db.admin.execute<{ n: string }>(
    'select count(*)::text as n from public.audit_events where actor_id = $1',
    [actorId],
  );
  return Number(row?.n);
};

/** An agent's credential under a live delegation from the world's manager. */
const agentCredential = async (purpose: string): Promise<string> => {
  const task = await c.createTask(`work an agent holds while tips are dismissed (${purpose})`);
  const reservationId = await c.approve(await c.propose(task.id, task.revision, purpose));
  return String((await c.pickup(reservationId))['credential']);
};

describe.skipIf(serverUrl === undefined)('MP-9-1 security through the tip dismiss', () => {
  usePreferencesWorld('mp91sec');
  isolation();
  ownPreferenceOnly();
  writeRefused();
  noAudit();
});

function isolation(): void {
  it('MP-9-1 isolation: a tip dismissed across another business, another client and an agent under a live delegation is never read, counted or changed', async () => {
    expect((await dismiss({ ...TIP, version: 1 }, adaToken)).status).toBe(200);
    const adaRows = await rowsOf(ada.personId);
    await acrossBusinesses();
    await acrossClients();
    await acrossDelegation();
    expect(await rowsOf(ada.personId)).toStrictEqual(adaRows);
  });
}

/** Another business: refused at this business's address, its own at its own. */
async function acrossBusinesses(): Promise<void> {
  const bravo = await insertBusiness(fixture.db.app, 'bravo');
  await installSpine(fixture.db.app, bravo);
  const bruno = await enrol(fixture.db.app, bravo, 'Bruno Tip');
  await fixture.db.app.withBusiness(bravo, async (tx) => await grantTo(tx, bruno, 'read'));
  const brunoToken = await tokenFor(bruno.presented.subject);
  const across = await dismiss({ ...TIP, version: 2 }, brunoToken);
  expect(across.status, JSON.stringify(across.body)).toBe(403);
  expectNoCanary(across);
  const lookedAcross = await call('preference.read', {}, brunoToken);
  expect(lookedAcross.status).toBe(403);
  expectNoCanary(lookedAcross);
  expect((await dismiss({ ...TIP, version: 2 }, brunoToken, { key: 'bravo' })).status).toBe(200);
  const brunoOwn = await call('preference.read', {}, brunoToken, { key: 'bravo' });
  expect(brunoOwn.status).toBe(200);
  expect(brunoOwn.body['preferences']).toStrictEqual({
    'tips.dismissed': { [tipKey(TIP.page, TIP.tip)]: 2 },
  });
}

/** Two clients of this business, one grant each: each reaches its own row. */
async function acrossClients(): Promise<void> {
  const cleo = await enrol(fixture.db.app, fixture.business, 'Cleo Client A');
  const cy = await enrol(fixture.db.app, fixture.business, 'Cy Client B');
  await fixture.db.app.withBusiness(fixture.business, async (tx) => {
    for (const person of [cleo, cy]) {
      // oxlint-disable-next-line no-await-in-loop
      const made = await createClient(tx, `Client ${randomUUID()}`, ada.actorId);
      if (!made.ok) throw new Error('client not made');
      // oxlint-disable-next-line no-await-in-loop
      await grantTo(tx, person, 'read', { kind: 'party', id: made.value });
    }
  });
  const cleoToken = await tokenFor(cleo.presented.subject);
  const cyToken = await tokenFor(cy.presented.subject);
  expect((await dismiss({ ...TIP, version: 3 }, cleoToken)).status).toBe(200);
  expect((await dismiss({ ...OTHER, version: 1 }, cyToken)).status).toBe(200);
  for (const [token, own] of [
    [cleoToken, { [tipKey(TIP.page, TIP.tip)]: 3 }],
    [cyToken, { [tipKey(OTHER.page, OTHER.tip)]: 1 }],
  ] as const) {
    // oxlint-disable-next-line no-await-in-loop
    const seen = await call('preference.read', {}, token);
    expect(seen.status).toBe(200);
    expect(seen.body['preferences']).toStrictEqual({ 'tips.dismissed': own });
    expect(dismissedTipCount(seen.body['preferences'] as Record<string, unknown>)).toBe(1);
    expectNoCanary(seen);
  }
}

/** An agent under a live delegation dismisses and reads nothing. */
async function acrossDelegation(): Promise<void> {
  const credential = await agentCredential('tip_isolation');
  const principal = c.manager.personId;
  const principalRows = await rowsOf(principal);
  const asAgent = await c.asAgent(
    'preference.dismiss_tip',
    { operationId: randomUUID(), ...TIP, version: 4 },
    credential,
  );
  const agentLooks = await c.asAgent('preference.read', {}, credential);
  for (const answer of [asAgent, agentLooks]) {
    expect(answer.status).toBe(403);
    expect(answer.body['code']).toBe('DELEGATION_EXCLUDES_OPERATION');
    expectNoCanary(answer);
  }
  expect(await rowsOf(principal)).toStrictEqual(principalRows);
}

function ownPreferenceOnly(): void {
  it('MP-9-1 own preference only: a tip dismissed naming another person is refused and writes nothing', async () => {
    expect((await dismiss({ ...TIP, version: 5 }, adaToken)).status).toBe(200);
    const adaRows = await rowsOf(ada.personId);
    const benRows = await rowsOf(ben.personId);
    // `personId` is system-owned on every row; any other spelling is a field
    // the dismiss does not describe. Either way the body is refused whole.
    for (const [aim, status, code] of [
      ['personId', 422, 'FIELD_NOT_WRITABLE'],
      ['person', 400, 'COMMAND_BODY_INVALID'],
      ['recipientPersonId', 400, 'COMMAND_BODY_INVALID'],
      ['ownerPersonId', 400, 'COMMAND_BODY_INVALID'],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop
      const aimed = await dismiss({ ...TIP, version: 6, [aim]: ada.personId }, benToken);
      expect(aimed.status, aim).toBe(status);
      expect(aimed.body['code'], aim).toBe(code);
      expectNoCanary(aimed);
    }
    expect(await rowsOf(ada.personId)).toStrictEqual(adaRows);
    expect(await rowsOf(ben.personId)).toStrictEqual(benRows);
    expect(await dismissedOf(adaToken)).toStrictEqual({ [tipKey(TIP.page, TIP.tip)]: 5 });
  });
}

function writeRefused(): void {
  it('MP-9-1 preference:write refused: a person with no membership and an agent dismiss no tip', async () => {
    const outsider = await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      // A mapped person with no membership (R4): no role key, so no preference:write.
      const personId = await insertPerson(tx, 'Olive Tip');
      const actorId = await insertActor(tx, personId);
      const subject = `outside-${randomUUID()}`;
      await insertMapping(tx, await insertLogin(tx, subject), personId, actorId);
      const member = { personId, actorId, presented: { provider: 'supabase', subject } } as const;
      await grantTo(tx, member, 'read', { kind: 'party', id: randomUUID() });
      return { personId, subject };
    });
    const refused = await dismiss({ ...TIP, version: 1 }, await tokenFor(outsider.subject));
    expect(refused.status).toBe(403);
    expect(refused.body['code']).toBe('SCOPE_NOT_GRANTED');
    expect(await rowsOf(outsider.personId)).toStrictEqual([]);

    const credential = await agentCredential('tip_refused');
    const principalRows = await rowsOf(c.manager.personId);
    const asAgent = await c.asAgent(
      'preference.dismiss_tip',
      { operationId: randomUUID(), ...TIP, version: 1 },
      credential,
    );
    expect(asAgent.status).toBe(403);
    expect(asAgent.body['code']).toBe('DELEGATION_EXCLUDES_OPERATION');
    expect(await rowsOf(c.manager.personId)).toStrictEqual(principalRows);
  });
}

function noAudit(): void {
  it('MP-9-1 no audit on preference: a tip dismissed and the preferences read add no audit event; a refused dismissal does', async () => {
    const before = await auditsOf(ben.actorId);
    expect((await dismiss({ ...OTHER, version: 2 }, benToken)).status).toBe(200);
    expect((await call('preference.read', {}, benToken)).status).toBe(200);
    expect(await auditsOf(ben.actorId)).toBe(before);
    // The counter sees this actor: a refused dismissal is audited as every refusal is.
    expect((await dismiss({ ...OTHER, version: 0 }, benToken)).status).toBe(422);
    expect(await auditsOf(ben.actorId)).toBe(before + 1);
  });
}
