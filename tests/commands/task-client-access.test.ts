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
import {
  insertActor,
  insertBusiness,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from './fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { verifyAuditChain } from '../../packages/core-commands/src/commands/audit.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/surface.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import { agentWorld, codeOf, type AgentWorld } from './agent-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'task-client-access: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

const CANARY = `canary-${randomUUID()}`;
const SHARE = 'task.share_with_client';
const REVOKE = 'task.revoke_client_share';

const outcomeOf = (answer: CommandResult | Awaited<ReturnType<typeof executeRead>>) =>
  isCommandRefusal(answer) ? { code: answer.code, names: answer.names } : { applied: true };

/** The shares a task carries: live record-scoped `task:read` rows, by holder. */
const SHARES_SQL = `select subject_id as person_id, granted_by_actor_id, revoked_at is null as live
                      from public.grants
                     where scope_kind = 'record' and scope_id = $1 and subject_kind = 'person'
                       and collection = 'task' and action = 'read'
                     order by granted_at`;

interface ShareRow {
  readonly person_id: string;
  readonly granted_by_actor_id: string;
  readonly live: boolean;
}

describe.skipIf(serverUrl === undefined)('MP-4-10 client access', () => {
  let db: FreshDatabase;
  let alpha: BusinessId;
  let bravo: BusinessId;
  let admin: Member;
  let taskSharer: Member;
  let scopedSharer: Member;
  let reader: Member;
  let bravoAdmin: Member;
  const clientA = randomUUID();
  const clientB = randomUUID();
  let clientAPeople: Member[];
  let clientBPerson: Member;

  const as = async (business: BusinessId, member: Member, body: Record<string, unknown>) =>
    await executeCommand(db.app, business, member.presented, 'api', {
      operationId: randomUUID(),
      ...body,
    } as never);

  const revisionOf = async (recordId: string) =>
    Number(
      (
        await db.admin.execute<{ readonly revision: string }>(
          `select revision::text as revision from public.records where id = $1`,
          [recordId],
        )
      )[0]?.revision,
    );

  const sharesOf = async (recordId: string) =>
    await db.admin.execute<ShareRow>(SHARES_SQL, [recordId]);

  const liveHolders = async (recordId: string) =>
    (await sharesOf(recordId))
      .filter((share) => share.live)
      .map((share) => share.person_id)
      .toSorted();

  /** A task with a title, set on a client by the admin through `task.set_party`. */
  const fresh = async (
    business: BusinessId,
    by: Member,
    title: string,
    client: string | null,
  ): Promise<string> => {
    const made = await as(business, by, { command: 'task.create', fields: { title } });
    if (isCommandRefusal(made)) throw new Error(`create refused ${made.code}`);
    const recordId = made.recordId ?? '';
    if (client !== null) {
      const set = await as(business, by, {
        command: 'task.set_party',
        recordId,
        expectedRevision: await revisionOf(recordId),
        fields: { client },
      });
      if (isCommandRefusal(set)) throw new Error(`set_party refused ${set.code}`);
    }
    return recordId;
  };

  const toggle = async (
    business: BusinessId,
    by: Member,
    command: typeof SHARE | typeof REVOKE,
    recordId: string,
    operationId: string = randomUUID(),
  ) =>
    await as(business, by, {
      command,
      operationId,
      recordId,
      expectedRevision: await revisionOf(recordId),
    });

  /**
   * One of a client's existing people: a person with a login and no
   * membership, standing on the client through a party-scoped `task:read`.
   */
  const clientPerson = async (business: BusinessId, client: string, by: Member) =>
    await db.app.withBusiness(business, async (tx) => {
      const subject = `client-person-${randomUUID()}`;
      const personId = await insertPerson(tx, subject);
      const actorId = await insertActor(tx, personId);
      await insertMapping(tx, await insertLogin(tx, subject), personId, by.actorId);
      const issued = await issueGrant(tx, [], {
        subject: { kind: 'person', id: personId },
        scope: { kind: 'party', id: client },
        collection: 'task',
        action: 'read',
        parentGrantId: null,
        grantedByActorId: by.actorId,
      });
      if (!issued.ok) throw new Error(`clientPerson: refused ${issued.refusal.code}`);
      return {
        personId,
        actorId,
        presented: { provider: 'supabase', subject },
        partyGrantId: issued.value,
      } as Member & { readonly partyGrantId: string };
    });

  const readAs = async (business: BusinessId, member: Member, recordId: string) =>
    await executeRead(db.app, business, member.presented, { read: 'task.read', recordId });

  const clientAccessOf = async (member: Member, recordId: string) => {
    const read = await readAs(alpha, member, recordId);
    return isCommandRefusal(read) || !('task' in read) ? null : read.task.clientAccess;
  };

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'hc' });
    alpha = (await insertBusiness(db.app, 'access-alpha')) as BusinessId;
    bravo = (await insertBusiness(db.app, 'access-bravo')) as BusinessId;
    await installSpine(db.app, alpha);
    await installSpine(db.app, bravo);
    admin = await enrol(db.app, alpha, 'admin');
    taskSharer = await enrol(db.app, alpha, 'task-sharer');
    scopedSharer = await enrol(db.app, alpha, 'scoped-sharer');
    reader = await enrol(db.app, alpha, 'reader');
    bravoAdmin = await enrol(db.app, bravo, 'bravo-admin');
    await db.app.withBusiness(alpha, async (tx) => {
      for (const action of ['read', 'write', 'share'] as const) {
        // oxlint-disable-next-line no-await-in-loop
        await grantTo(tx, admin, action);
        // oxlint-disable-next-line no-await-in-loop
        await grantTo(tx, taskSharer, action);
      }
      await grantTo(tx, admin, 'share', undefined, false, 'access');
      await grantTo(tx, scopedSharer, 'read');
      await grantTo(tx, reader, 'read');
    });
    await db.app.withBusiness(bravo, async (tx) => {
      for (const action of ['read', 'write', 'share'] as const) {
        // oxlint-disable-next-line no-await-in-loop
        await grantTo(tx, bravoAdmin, action);
      }
      await grantTo(tx, bravoAdmin, 'share', undefined, false, 'access');
    });
    clientAPeople = [
      await clientPerson(alpha, clientA, admin),
      await clientPerson(alpha, clientA, admin),
    ];
    clientBPerson = await clientPerson(alpha, clientB, admin);
  }, 180_000);

  afterAll(async () => {
    await db?.drop();
  });

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

  describe('MP-4-10 audited changes: share grant created, share grant revoked', () => {
    it('writes each change in the command’s transaction and joins the audit chain', async () => {
      const task = await fresh(alpha, admin, 'audited', clientA);
      const [created, revoked, refusedOp] = [randomUUID(), randomUUID(), randomUUID()];
      await toggle(alpha, admin, SHARE, task, created);
      const liveAfterCreate = await liveHolders(task);
      await toggle(alpha, admin, REVOKE, task, revoked);
      await toggle(alpha, reader, SHARE, task, refusedOp);
      const events = await db.admin.execute<{
        readonly command: string;
        readonly actor_id: string;
        readonly outcome: string;
        readonly refusal_code: string | null;
        readonly subject_record_id: string | null;
      }>(
        `select command, actor_id, outcome, refusal_code, subject_record_id from public.audit_events
          where business_id = $1 and operation_id = any($2::text[])
          order by seq`,
        [alpha, [created, revoked, refusedOp]],
      );
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

  describe('MP-4-10 isolation: client access', () => {
    it('another business: its task is not found and gains no share', async () => {
      const foreign = await fresh(bravo, bravoAdmin, CANARY, clientA);
      const answer = await as(alpha, admin, {
        command: SHARE,
        recordId: foreign,
        expectedRevision: await revisionOf(foreign),
      });
      expect(outcomeOf(answer)).toMatchObject({ code: 'NOT_FOUND' });
      expect(JSON.stringify(answer)).not.toContain(CANARY);
      expect(await sharesOf(foreign)).toHaveLength(0);
      // And bravo turning on its own task shares with none of alpha's client people.
      await toggle(bravo, bravoAdmin, SHARE, foreign);
      expect(await sharesOf(foreign)).toHaveLength(0);
    });

    it('another client in the same business: client A’s task reaches client A’s people only', async () => {
      const taskA = await fresh(alpha, admin, 'client A only', clientA);
      const taskB = await fresh(alpha, admin, CANARY, clientB);
      await toggle(alpha, admin, SHARE, taskA);
      expect(await liveHolders(taskA)).not.toContain(clientBPerson.personId);
      const crossRead = await readAs(alpha, clientBPerson, taskA);
      expect(outcomeOf(crossRead)).toMatchObject({ code: 'NOT_FOUND' });
      // Client A's person cannot open client B's task, shared or not.
      await toggle(alpha, admin, SHARE, taskB);
      const other = await readAs(alpha, clientAPeople[0] as Member, taskB);
      expect(outcomeOf(other)).toMatchObject({ code: 'NOT_FOUND' });
      expect(JSON.stringify(other)).not.toContain(CANARY);
    });

    it('a sharer scoped to client A’s task cannot share client B’s', async () => {
      const taskA = await fresh(alpha, admin, 'scoped A', clientA);
      const taskB = await fresh(alpha, admin, CANARY, clientB);
      await db.app.withBusiness(alpha, async (tx) => {
        await grantTo(tx, scopedSharer, 'share', { kind: 'record', id: taskA }, false, 'access');
      });
      expect(outcomeOf(await toggle(alpha, scopedSharer, SHARE, taskA))).toStrictEqual({
        applied: true,
      });
      const refused = await toggle(alpha, scopedSharer, SHARE, taskB);
      expect(outcomeOf(refused)).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
      expect(JSON.stringify(refused)).not.toContain(CANARY);
      expect(await sharesOf(taskB)).toHaveLength(0);
    });
  });
});

describe.skipIf(serverUrl === undefined)(
  'MP-4-10 isolation: client access under a live delegation',
  () => {
    let world: AgentWorld;

    beforeAll(async () => {
      world = await agentWorld('hca', `access-agent-${randomUUID().slice(0, 8)}`);
    }, 180_000);

    afterAll(async () => {
      await world?.drop();
    });

    it('an agent is refused both ways, even on its own task and under a sharer’s delegation', async () => {
      const decider = await world.decider('decider');
      await world.db.app.withBusiness(world.business, async (tx) => {
        await grantTo(tx, decider, 'share', undefined, false, 'access');
      });
      const picked = await world.pickUp(decider, 'the agent’s task');
      const grantsBefore = await world.db.admin.execute<{ readonly n: string }>(
        `select count(*)::text as n from public.grants where business_id = $1`,
        [world.business],
      );
      const agentToggle = async (command: string) => {
        const rows = await world.db.admin.execute<{ readonly revision: string }>(
          `select revision::text as revision from public.records where id = $1`,
          [picked.taskId],
        );
        return await world.asAgent(
          {
            command,
            operationId: randomUUID(),
            recordId: picked.taskId,
            expectedRevision: Number(rows[0]?.revision),
          },
          picked.credential,
        );
      };
      expect(codeOf(await agentToggle(SHARE))).not.toBe('not-a-refusal');
      expect(codeOf(await agentToggle(REVOKE))).not.toBe('not-a-refusal');
      const grantsAfter = await world.db.admin.execute<{ readonly n: string }>(
        `select count(*)::text as n from public.grants where business_id = $1`,
        [world.business],
      );
      expect(grantsAfter[0]?.n).toBe(grantsBefore[0]?.n);
    });
  },
);
