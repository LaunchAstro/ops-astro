// SPDX-License-Identifier: AGPL-3.0-only
//
// C32 (CS-2.15): the client record, and grants given and revoked on Settings ▸
// Access. A client is a row of its business (`client.create`, the tracked
// action `record created (client)` under `record:write`); a grant names a
// person of the business, a key from the catalogue and either the whole
// business or one client (`access.grant` and `access.revoke`, the tracked
// action `grant changed` under `access:manage`, never an agent's). The
// person's preview on `access.read` is the grant check's own walk, so a
// teammate given one client sees that client and nothing else, and
// `client.list` answers the clients a caller's live grants reach, filtered
// inside the query.
//
// Ada is alpha's owner and holds every key the surface declares; Mia holds the
// task keys at business scope and nothing else; Noah holds nothing; Tia is a
// teammate enrolled here with no grant. Bea is bravo's, holding `access:manage`
// and `record:write` there. A client person of alpha stands on a share, and
// the agent acts under a live delegation from Ada. Every name below is made up.

import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { checkAuthority } from '../../packages/core-records/src/authority/grants.ts';
import { serverUrl } from '../acceptance/world.ts';
import { enrol } from '../commands/fixture.ts';
import {
  CANARY,
  detailOf,
  outcome,
  harness,
  tia,
  tiaToken,
  as,
  createClient,
  give,
  revoke,
  listClients,
  previewOf,
  rowsOf,
  useClientsWorld,
} from './c32-clients-world.ts';

useClientsWorld();

async function c32GrantChangedATeammateGivenOne(): Promise<void> {
  const one = await createClient(`Harbour Physio ${randomUUID().slice(0, 6)}`);
  const other = await createClient(`Ridge Dental ${randomUUID().slice(0, 6)}`);
  expect((await previewOf(tia.personId)).permissions).toEqual([]);

  const given = await give({
    holderId: tia.personId,
    collection: 'task',
    action: 'read',
    clientId: one,
  });
  expect(outcome(given)).toEqual({ status: 200, code: 'ok' });
  const grantId = String(detailOf(given)['grantId']);

  const preview = await previewOf(tia.personId);
  expect(preview.permissions).toEqual([
    { collection: 'task', action: 'read', scope: { kind: 'party', id: one } },
  ]);
  expect(preview.clientRecords).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ clientId: one }),
      expect.objectContaining({ clientId: other }),
    ]),
  );

  // The preview is what the grant check grants: that client, not the other,
  // and not the whole business.
  const asked = await harness.world.db.app.withBusiness(harness.world.alpha, async (tx) => {
    const subjects = [{ kind: 'person' as const, id: tia.personId }];
    const on = async (kind: 'party' | 'business', id: string | null) =>
      (
        await checkAuthority(tx, subjects, {
          collection: 'task',
          action: 'read',
          scope: { kind, id },
        })
      ).ok;
    return [await on('party', one), await on('party', other), await on('business', null)];
  });
  expect(asked).toEqual([true, false, false]);

  // Tia's own list of clients is the one she was given.
  const listed = await listClients(tiaToken);
  expect(listed.status).toBe(200);
  expect(listed.body['clients']).toEqual([
    { clientId: one, name: expect.stringContaining('Harbour Physio') },
  ]);

  // The same grant given again is the same grant.
  const again = await give({
    holderId: tia.personId,
    collection: 'task',
    action: 'read',
    clientId: one,
  });
  expect(detailOf(again)['grantId']).toBe(grantId);

  const revoked = await revoke(grantId);
  expect(outcome(revoked)).toEqual({ status: 200, code: 'ok' });
  expect((await previewOf(tia.personId)).permissions).toEqual([]);
  expect(outcome(await listClients(tiaToken))).toEqual({
    status: 403,
    code: 'SCOPE_NOT_GRANTED',
  });
  expect(outcome(await revoke(grantId))).toEqual({ status: 404, code: 'NOT_FOUND' });

  // Each change is its tracked action, audited in alpha against Ada, with a
  // digest and no body; the grant row keeps who gave it and when it ended.
  const stored = await harness.world.db.app.withBusiness(harness.world.alpha, async (tx) => ({
    audited: await tx.query<{ readonly command: string; readonly n: number }>(
      `select command, count(*)::int as n from public.audit_events
        where actor_id = $1 and outcome = 'applied'
          and command in ('client.create', 'access.grant', 'access.revoke')
        group by command order by command`,
      [harness.world.ada.actorId],
    ),
    grant: await tx.query<{
      readonly by: string;
      readonly ended: boolean;
      readonly scope: string;
    }>(
      `select granted_by_actor_id::text as by, revoked_at is not null as ended,
              scope_kind || ':' || scope_id as scope
         from public.grants where id = $1`,
      [grantId],
    ),
  }));
  expect(stored.audited).toEqual(
    expect.arrayContaining([
      { command: 'access.grant', n: expect.any(Number) },
      { command: 'access.revoke', n: 1 },
      { command: 'client.create', n: expect.any(Number) },
    ]),
  );
  expect(stored.grant).toEqual([
    { by: harness.world.ada.actorId, ended: true, scope: `party:${one}` },
  ]);
}

async function c32GrantChangedTheWholeBusinessIs(): Promise<void> {
  const whole = await give({ holderId: tia.personId, collection: 'report', action: 'read' });
  expect(outcome(whole)).toEqual({ status: 200, code: 'ok' });
  expect((await previewOf(tia.personId)).permissions).toEqual([
    { collection: 'report', action: 'read', scope: { kind: 'business', id: null } },
  ]);
  expect(outcome(await revoke(detailOf(whole)['grantId']))).toEqual({
    status: 200,
    code: 'ok',
  });

  const before = await rowsOf(harness.world.alpha);
  const base = { holderId: tia.personId, collection: 'task', action: 'read' };
  const cases: readonly (readonly [Readonly<Record<string, unknown>>, string, number, string])[] = [
    [{ ...base, collection: 'tasks' }, 'collection', 422, 'FIELD_VALUE_INVALID'],
    [{ ...base, collection: 'TASK' }, 'collection', 422, 'FIELD_VALUE_INVALID'],
    [{ ...base, collection: ' task' }, 'collection', 422, 'FIELD_VALUE_INVALID'],
    [{ ...base, collection: 7 }, 'collection', 422, 'FIELD_VALUE_INVALID'],
    [{ ...base, action: 'own' }, 'action', 422, 'FIELD_VALUE_INVALID'],
    [{ ...base, action: undefined }, 'action', 422, 'FIELD_VALUE_INVALID'],
    // A key the catalogue does not hold: nothing checks `export:manage`.
    [{ ...base, collection: 'export', action: 'manage' }, 'action', 422, 'FIELD_VALUE_INVALID'],
    // Self-scoped keys every person holds on their own account are never granted.
    [{ ...base, collection: 'account', action: 'write' }, 'collection', 422, 'FIELD_VALUE_INVALID'],
    [
      { ...base, collection: 'preference', action: 'write' },
      'collection',
      422,
      'FIELD_VALUE_INVALID',
    ],
    [
      { ...base, collection: 'credential', action: 'write' },
      'collection',
      422,
      'FIELD_VALUE_INVALID',
    ],
    [{ ...base, holderId: 'not-an-id' }, 'holderId', 422, 'FIELD_VALUE_INVALID'],
    [{ ...base, clientId: 'not-an-id' }, 'clientId', 422, 'FIELD_VALUE_INVALID'],
    [{ ...base, holderId: randomUUID() }, 'holderId', 404, 'NOT_FOUND'],
    [{ ...base, clientId: randomUUID() }, 'clientId', 404, 'NOT_FOUND'],
    // Noah's person is a member; the orphan's login has no membership.
    [{ ...base, holderId: harness.world.orphan.personId }, 'holderId', 404, 'NOT_FOUND'],
  ];
  // A former member: the membership is there and ended.
  const leo = await enrol(harness.world.db.app, harness.world.alpha, 'leo');
  await harness.world.db.app.withBusiness(harness.world.alpha, async (tx) => {
    await tx.query(
      'update public.memberships set active = false, ended_at = now() where person_id = $1',
      [leo.personId],
    );
  });
  const former = await give({ ...base, holderId: leo.personId });
  expect(outcome(former)).toEqual({ status: 404, code: 'NOT_FOUND' });
  for (const [body, field, status, code] of cases) {
    // oxlint-disable-next-line no-await-in-loop
    const answer = await give(body);
    expect(outcome(answer), field).toEqual({ status, code });
    expect(JSON.stringify(answer.body), field).toContain(field);
  }
  const undeclared = await give({ ...base, scope: 'business' });
  expect(outcome(undeclared)).toEqual({ status: 400, code: 'COMMAND_BODY_INVALID' });

  for (const name of [
    '',
    '   ',
    'x'.repeat(201),
    7,
    `nul \u0000 ${CANARY}`,
    `lone \uD800 ${CANARY}`,
  ]) {
    // oxlint-disable-next-line no-await-in-loop
    const answer = await as('/client/create', { operationId: randomUUID(), name });
    expect(outcome(answer), String(name)).toEqual({ status: 422, code: 'FIELD_VALUE_INVALID' });
    expect(JSON.stringify(answer.body)).not.toContain(CANARY);
  }
  expect(await rowsOf(harness.world.alpha)).toEqual(before);

  // One name per business, in any letter case.
  const taken = `Coastal Vets ${randomUUID().slice(0, 6)}`;
  await createClient(taken);
  const twice = await as('/client/create', {
    operationId: randomUUID(),
    name: taken.toUpperCase(),
  });
  expect(outcome(twice)).toEqual({ status: 409, code: 'CLIENT_NAME_TAKEN' });
}

describe.skipIf(serverUrl === undefined)(
  'C32 the client record and grants on Settings ▸ Access',
  () => {
    it(
      'C32 grant changed: a teammate given one client sees that client only in their preview, and the change and its revocation are recorded and audited',
      c32GrantChangedATeammateGivenOne,
    );

    it(
      'C32 grant changed: the whole business is a grant with no client, and malformed, unknown or self-scoped input is refused by name with nothing written',
      c32GrantChangedTheWholeBusinessIs,
    );

    it('C32 grant changed: the last business-wide holder of access:manage is never revoked, so the business always has someone to change access', async () => {
      const held = await harness.world.db.app.withBusiness(
        harness.world.alpha,
        async (tx) =>
          await tx.query<{ readonly id: string }>(
            `select id from public.grants
        where subject_kind = 'person' and subject_id = $1 and collection = 'access'
          and action = 'manage' and scope_kind = 'business' and revoked_at is null`,
            [harness.world.ada.personId],
          ),
      );
      expect(held).toHaveLength(1);
      const last = await revoke(held[0]?.id);
      expect(outcome(last)).toEqual({ status: 409, code: 'ACCESS_LAST_MANAGER' });

      // With a second holder, the first may go, and then the second is the last.
      const second = await give({ holderId: tia.personId, collection: 'access', action: 'manage' });
      expect(outcome(second)).toEqual({ status: 200, code: 'ok' });
      expect(outcome(await revoke(held[0]?.id))).toEqual({ status: 200, code: 'ok' });
      expect(outcome(await revoke(detailOf(second)['grantId'], tiaToken))).toEqual({
        status: 409,
        code: 'ACCESS_LAST_MANAGER',
      });
      // Ada's key back, then Tia's gone, as the rest of the file expects.
      const back = await give(
        { holderId: harness.world.ada.personId, collection: 'access', action: 'manage' },
        tiaToken,
      );
      expect(outcome(back)).toEqual({ status: 200, code: 'ok' });
      expect(outcome(await revoke(detailOf(second)['grantId']))).toEqual({
        status: 200,
        code: 'ok',
      });
    });
  },
);
