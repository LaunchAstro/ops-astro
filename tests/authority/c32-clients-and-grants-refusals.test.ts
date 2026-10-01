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
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { grantAccess } from '../../packages/core-records/src/index.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { serverUrl } from '../acceptance/world.ts';
import type { Member } from '../commands/fixture.ts';
import {
  member,
  detailOf,
  outcome,
  harness,
  tia,
  tiaToken,
  clientToken,
  as,
  createClient,
  give,
  revoke,
  rowsOf,
  useClientsWorld,
} from './c32-clients-world.ts';

useClientsWorld();

async function c32GrantsAtOnceTwoOfThe(): Promise<void> {
  const clientId = await createClient(`Parallel Pilates ${randomUUID().slice(0, 6)}`);
  const wide = connect(harness.world.db.appUrl, { source: 'runtime', max: 2 });
  const grant = {
    personId: tia.personId,
    collection: 'task',
    action: 'comment' as const,
    clientId,
  };
  const actorId = harness.world.ada.actorId as string;
  try {
    const both = await Promise.all(
      [0, 1].map(
        async () =>
          await wide.withBusiness(harness.world.alpha, async (tx) => {
            const given = await grantAccess(tx, grant, actorId);
            await tx.query('select pg_sleep(0.2)');
            return given;
          }),
      ),
    );
    expect(both.map((given) => given.ok)).toEqual([true, true]);
    const rows = await harness.world.db.app.withBusiness(
      harness.world.alpha,
      async (tx) =>
        await tx.query<{ readonly n: number }>(
          `select count(*)::int as n from public.grants
          where subject_id = $1 and collection = 'task' and action = 'comment'
            and scope_id = $2 and revoked_at is null`,
          [tia.personId, clientId],
        ),
    );
    expect(rows[0]?.n).toBe(1);
    const given = both[0];
    expect((await revoke(given?.ok === true ? given.value : null)).code).toBe('ok');
  } finally {
    await wide.close();
  }

  // Two managers, each revoking the other's key at once, on two connections
  // that truly overlap: one revocation applies, the other is the last.
  const second = await give({ holderId: tia.personId, collection: 'access', action: 'manage' });
  const managers = await harness.world.db.app.withBusiness(
    harness.world.alpha,
    async (tx) =>
      await tx.query<{ readonly id: string; readonly person: string }>(
        `select id, subject_id::text as person from public.grants
        where collection = 'access' and action = 'manage' and scope_kind = 'business'
          and revoked_at is null order by granted_at`,
      ),
  );
  expect(managers).toHaveLength(2);
  const pair = connect(harness.world.db.appUrl, { source: 'runtime', max: 2 });
  const byPerson = new Map([
    [harness.world.ada.personId, member(harness.world.ada).presented],
    [tia.personId, tia.presented],
  ]);
  let codes: string[];
  try {
    // Each manager revokes the other's key, through the real command.
    codes = await Promise.all(
      managers.map(async (held) => {
        const other = managers.find((one) => one.id !== held.id)?.person as string;
        const result = await executeCommand(
          pair,
          harness.world.alpha,
          byPerson.get(other) as Member['presented'],
          'api',
          { command: 'access.revoke', operationId: randomUUID(), grantId: held.id },
        );
        return isCommandRefusal(result) ? result.code : 'ok';
      }),
    );
  } finally {
    await pair.close();
  }
  expect(codes.toSorted()).toEqual(['ACCESS_LAST_MANAGER', 'ok']);
  const left = await harness.world.db.app.withBusiness(
    harness.world.alpha,
    async (tx) =>
      await tx.query<{ readonly person: string }>(
        `select subject_id::text as person from public.grants
        where collection = 'access' and action = 'manage' and scope_kind = 'business'
          and revoked_at is null`,
      ),
  );
  expect(left).toHaveLength(1);
  // Leave Ada holding it, and Tia not, for the cases after this one.
  if (left[0]?.person !== harness.world.ada.personId) {
    const back = await give(
      { holderId: harness.world.ada.personId, collection: 'access', action: 'manage' },
      tiaToken,
    );
    expect(back.code).toBe('ok');
    expect((await revoke(detailOf(second)['grantId'])).code).toBe('ok');
  }
}

describe.skipIf(serverUrl === undefined)(
  'C32 the client record and grants on Settings ▸ Access',
  () => {
    it(
      'C32 grants at once: two of the same grant given at once make one row, and two last managers revoked at once leave one',
      c32GrantsAtOnceTwoOfThe,
    );

    it('C32 refusal access:manage: a task holder, a member with nothing and a client are refused grants and revocations, and record:write guards a new client, with nothing written', async () => {
      const clientId = await createClient(`Refusal Clinic ${randomUUID().slice(0, 6)}`);
      const given = await give({
        holderId: tia.personId,
        collection: 'task',
        action: 'read',
        clientId,
      });
      const grantId = detailOf(given)['grantId'];
      const before = await rowsOf(harness.world.alpha);
      for (const token of [harness.world.mia.token, harness.world.noah.token, clientToken]) {
        const answers = [
          // oxlint-disable-next-line no-await-in-loop
          await give(
            { holderId: tia.personId, collection: 'task', action: 'write', clientId },
            token,
          ),
          // oxlint-disable-next-line no-await-in-loop
          await revoke(grantId, token),
          // oxlint-disable-next-line no-await-in-loop
          await as('/access/read', {}, token),
        ];
        for (const answer of answers) {
          expect(outcome(answer)).toEqual({ status: 403, code: 'SCOPE_NOT_GRANTED' });
        }
      }
      for (const token of [harness.world.noah.token, clientToken]) {
        // oxlint-disable-next-line no-await-in-loop
        const answer = await as(
          '/client/create',
          { operationId: randomUUID(), name: 'Nope' },
          token,
        );
        expect(outcome(answer)).toEqual({ status: 403, code: 'SCOPE_NOT_GRANTED' });
      }
      expect(await rowsOf(harness.world.alpha)).toEqual(before);
      expect((await revoke(grantId)).code).toBe('ok');
    });
  },
);
describe.skipIf(serverUrl === undefined)(
  'C32 the client record and grants on Settings ▸ Access',
  () => {
    it("C32 client link: a task names a client of its own business, and another business's client or a made-up one is NOT_FOUND with nothing written", async () => {
      const own = await createClient(`Linked Clinic ${randomUUID().slice(0, 6)}`);
      const bravoClient = await createClient(
        `Bravo Linked ${randomUUID().slice(0, 6)}`,
        harness.world.bea.token,
        'bravo',
      );
      const task = await harness.freshTask('a task with a client');
      const setParty = async (client: string, expectedRevision: number) =>
        await harness.asPerson('task.set_party', {
          operationId: randomUUID(),
          recordId: task.id,
          expectedRevision,
          fields: { client },
        });
      const linked = await setParty(own, task.revision);
      expect(outcome(linked)).toEqual({ status: 200, code: 'ok' });
      const revision = Number(detailOf(linked)['revision'] ?? linked.body['revision']);
      for (const foreign of [bravoClient, randomUUID()]) {
        // oxlint-disable-next-line no-await-in-loop
        const answer = await setParty(foreign, revision);
        expect(outcome(answer)).toEqual({ status: 404, code: 'NOT_FOUND' });
        expect(answer.body['names']).toEqual(['client']);
      }
      const stored = await harness.world.db.app.withBusiness(
        harness.world.alpha,
        async (tx) =>
          await tx.query<{ readonly client: string }>(
            'select uuid_7::text as client from public.records where id = $1',
            [task.id],
          ),
      );
      expect(stored).toEqual([{ client: own }]);
    });
  },
);
