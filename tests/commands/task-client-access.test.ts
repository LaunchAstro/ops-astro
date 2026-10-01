// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-10b: Client access (CS-4.10, R45).
//
// Client access is the existence of a share grant, drawn as the same tick as
// the Ad hoc mark. Turning it on shares the task, for reading, with the
// client's existing people: every person outside the business's membership
// who stands on the task's client through a live party-scoped `task:read`
// grant. It enrols and invites no one. Turning it off withdraws those shares.
// Both are `access:share`, which an agent never holds (contract 2.3 to 2.6),
// and each is its own audited change: `task.share_with_client` is `share grant
// created`, `task.revoke_client_share` is `share grant revoked`.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertMembership } from '../identity/fixture.ts';
import { type Member } from './fixture.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { verifyAuditChain } from '../../packages/core-commands/src/commands/audit.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/surface.ts';
import {
  auditOf,
  REVOKE,
  SHARE,
  admin,
  alpha,
  as,
  clientA,
  clientAPeople,
  clientAccessOf,
  clientB,
  clientPerson,
  db,
  fresh,
  liveHolders,
  outcomeOf,
  readAs,
  reader,
  revisionOf,
  serverUrl,
  setUp,
  sharesOf,
  taskSharer,
  tearDown,
  toggle,
} from './client-access-world.ts';

if (serverUrl === undefined) {
  console.warn(
    'task-client-access: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

beforeAll(async () => {
  if (serverUrl !== undefined) await setUp();
}, 180_000);

afterAll(async () => {
  if (serverUrl !== undefined) await tearDown();
});

describe.skipIf(serverUrl === undefined)('MP-4-10 client access', () => {
  it('is declared as access:share on the task, which an agent never reaches', () => {
    for (const name of [SHARE, REVOKE]) {
      const declared = COMMAND_SURFACE.find((each) => String(each.name) === name);
      expect([
        declared?.kind,
        declared?.collection,
        declared?.action,
        declared?.authorisedOn,
        declared?.agent,
      ]).toStrictEqual(['write', 'access', 'share', 'record', 'never']);
    }
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-10 client access', () => {
  describe('MP-4-10 client access is a share grant', () => {
    it('on shares the task with each of the client’s people; off withdraws them; the tick reads it', async () => {
      const task = await fresh(alpha, admin, 'shared with client A', clientA);
      expect(await clientAccessOf(admin, task)).toBe(false);

      expect(outcomeOf(await toggle(alpha, admin, SHARE, task))).toStrictEqual({ applied: true });
      expect(await liveHolders(task)).toStrictEqual(
        clientAPeople.map((person) => person.personId).toSorted(),
      );
      // Root grants, granted by the person who turned it on.
      for (const share of await sharesOf(task)) {
        expect(share.granted_by_actor_id).toBe(admin.actorId);
      }
      expect(await clientAccessOf(admin, task)).toBe(true);

      expect(outcomeOf(await toggle(alpha, admin, REVOKE, task))).toStrictEqual({ applied: true });
      expect(await liveHolders(task)).toStrictEqual([]);
      expect(await clientAccessOf(admin, task)).toBe(false);
    });

    it('turning it on twice leaves one share per person', async () => {
      const task = await fresh(alpha, admin, 'twice', clientA);
      await toggle(alpha, admin, SHARE, task);
      await toggle(alpha, admin, SHARE, task);
      expect(await sharesOf(task)).toHaveLength(clientAPeople.length);
    });
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-10 client access', () => {
  describe('MP-4-10 client access is a share grant', () => {
    it('two at once leave one share per person: the task row is the lock', async () => {
      const task = await fresh(alpha, admin, 'raced', clientA);
      const revision = await revisionOf(task);
      const [first, second] = await Promise.all(
        [0, 1].map(
          async () =>
            await as(alpha, admin, {
              command: SHARE,
              recordId: task,
              expectedRevision: revision,
            }),
        ),
      );
      expect([first, second].map((answer) => outcomeOf(answer as CommandResult))).toStrictEqual([
        { applied: true },
        { applied: true },
      ]);
      expect(await sharesOf(task)).toHaveLength(clientAPeople.length);
    });

    it('shares with no member, and with nobody whose standing on the client was revoked', async () => {
      const task = await fresh(alpha, admin, 'members and former', clientA);
      const former = await clientPerson(alpha, clientA, admin);
      const memberOnClient = await clientPerson(alpha, clientA, admin);
      await db.app.withBusiness(alpha, async (tx) => {
        await tx.query('update public.grants set revoked_at = now() where id = $1', [
          former.partyGrantId,
        ]);
        await insertMembership(tx, memberOnClient.personId);
      });
      await toggle(alpha, admin, SHARE, task);
      const holders = await liveHolders(task);
      expect(holders).not.toContain(former.personId);
      expect(holders).not.toContain(memberOnClient.personId);
      expect(holders).toStrictEqual(clientAPeople.map((person) => person.personId).toSorted());
    });
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-10 client access', () => {
  describe('MP-4-10 client access is a share grant', () => {
    it('off withdraws the old client’s shares after the client changed', async () => {
      const task = await fresh(alpha, admin, 'moved client', clientA);
      await toggle(alpha, admin, SHARE, task);
      const moved = await as(alpha, admin, {
        command: 'task.set_party',
        recordId: task,
        expectedRevision: await revisionOf(task),
        fields: { client: clientB },
      });
      expect(outcomeOf(moved)).toStrictEqual({ applied: true });
      // Still on: client A's people still see it until it is turned off.
      expect(await clientAccessOf(admin, task)).toBe(true);
      await toggle(alpha, admin, REVOKE, task);
      expect(await liveHolders(task)).toStrictEqual([]);
      expect(await clientAccessOf(admin, task)).toBe(false);
    });

    it('refuses a task with no client, and a client nobody stands on, writing nothing', async () => {
      const unset = await fresh(alpha, admin, 'no client', null);
      expect(outcomeOf(await toggle(alpha, admin, SHARE, unset))).toStrictEqual({
        code: 'FIELD_VALUE_INVALID',
        names: ['client'],
      });
      const empty = await fresh(alpha, admin, 'empty client', randomUUID());
      expect(outcomeOf(await toggle(alpha, admin, SHARE, empty))).toStrictEqual({
        code: 'FIELD_VALUE_INVALID',
        names: ['client'],
      });
      expect(await sharesOf(unset)).toHaveLength(0);
      expect(await sharesOf(empty)).toHaveLength(0);
    });
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-10 client access', () => {
  describe('MP-4-10 client access is a share grant', () => {
    it('does not share a trashed task', async () => {
      const task = await fresh(alpha, admin, 'trashed', clientA);
      const trashed = await as(alpha, admin, {
        command: 'task.trash',
        recordId: task,
        expectedRevision: await revisionOf(task),
      });
      expect(outcomeOf(trashed)).toStrictEqual({ applied: true });
      expect(outcomeOf(await toggle(alpha, admin, SHARE, task))).toMatchObject({
        code: 'NOT_FOUND',
      });
      expect(await sharesOf(task)).toHaveLength(0);
    });
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-10 client access', () => {
  describe('MP-4-10 CS-4.10 client sees it', () => {
    it('with it on the client’s person opens the task; with it off they cannot', async () => {
      const task = await fresh(alpha, admin, 'the client sees this', clientA);
      const person = clientAPeople[0] as Member;
      expect(outcomeOf(await readAs(alpha, person, task))).toMatchObject({ code: 'NOT_FOUND' });
      await toggle(alpha, admin, SHARE, task);
      const open = await readAs(alpha, person, task);
      expect(isCommandRefusal(open) ? null : 'sharedTask' in open).toBe(true);
      expect(
        isCommandRefusal(open) || !('sharedTask' in open) ? null : open.sharedTask.fields['title'],
      ).toBe('the client sees this');
      // The shared view carries no tick and no share: the client learns nothing about who else sees it.
      expect(JSON.stringify(open)).not.toContain('clientAccess');
      await toggle(alpha, admin, REVOKE, task);
      expect(outcomeOf(await readAs(alpha, person, task))).toMatchObject({ code: 'NOT_FOUND' });
    });
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-10 client access', () => {
  describe('MP-4-10 audited changes: share grant created, share grant revoked', () => {
    it('writes each change in the command’s transaction and joins the audit chain', async () => {
      const task = await fresh(alpha, admin, 'audited', clientA);
      const [created, revoked, refusedOp] = [randomUUID(), randomUUID(), randomUUID()];
      await toggle(alpha, admin, SHARE, task, created);
      const liveAfterCreate = await liveHolders(task);
      await toggle(alpha, admin, REVOKE, task, revoked);
      await toggle(alpha, reader, SHARE, task, refusedOp);
      const events = await auditOf([created, revoked, refusedOp]);
      // `toEqual`: the driver's rows are not plain objects.
      expect(events).toEqual([
        {
          command: SHARE,
          actor_id: admin.actorId,
          outcome: 'applied',
          refusal_code: null,
          subject_record_id: task,
        },
        {
          command: REVOKE,
          actor_id: admin.actorId,
          outcome: 'applied',
          refusal_code: null,
          subject_record_id: task,
        },
        {
          command: SHARE,
          actor_id: reader.actorId,
          outcome: 'refused',
          refusal_code: 'SCOPE_NOT_GRANTED',
          subject_record_id: null,
        },
      ]);
      expect(liveAfterCreate).toHaveLength(clientAPeople.length);
      const chain = await db.app.withBusiness(alpha, async (tx) => await verifyAuditChain(tx));
      expect(chain.intact).toBe(true);
    });
  });
});

describe.skipIf(serverUrl === undefined)('MP-4-10 client access', () => {
  describe('MP-4-10 permission refusals: access:share', () => {
    it('task:share without access:share neither creates nor revokes, and writes nothing', async () => {
      const task = await fresh(alpha, admin, 'not yours to share', clientA);
      const create = await toggle(alpha, taskSharer, SHARE, task);
      expect(outcomeOf(create)).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
      expect(await sharesOf(task)).toHaveLength(0);

      await toggle(alpha, admin, SHARE, task);
      const revoke = await toggle(alpha, taskSharer, REVOKE, task);
      expect(outcomeOf(revoke)).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
      expect(await liveHolders(task)).toHaveLength(clientAPeople.length);
    });

    it('a reader is refused both ways', async () => {
      const task = await fresh(alpha, admin, 'reader', clientA);
      expect(outcomeOf(await toggle(alpha, reader, SHARE, task))).toMatchObject({
        code: 'SCOPE_NOT_GRANTED',
      });
      expect(outcomeOf(await toggle(alpha, reader, REVOKE, task))).toMatchObject({
        code: 'SCOPE_NOT_GRANTED',
      });
      expect(await sharesOf(task)).toHaveLength(0);
    });
  });
});
