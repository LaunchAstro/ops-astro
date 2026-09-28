// SPDX-License-Identifier: AGPL-3.0-only
//
// The CQ-8 database suite's helpers: the wording rule's check, the lock
// classifier, and a world of two businesses with two clients each.

import { randomUUID } from 'node:crypto';
import {
  type BusinessId,
  type Database,
  type TenantQuery,
} from '../../packages/core-records/src/tenancy/database.ts';
import { shareRecord } from '../../packages/core-records/src/authority/shares.ts';
import {
  executeCommand,
  executeRead,
  isCommandRefusal,
} from '../../packages/core-commands/src/index.ts';
import { handback, heartbeat } from '../../packages/core-runtime/src/index.ts';
import {
  insertActor,
  insertBusiness,
  insertLogin,
  insertMapping,
  insertPerson,
} from '../identity/fixture.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { rows, type Schedules, type Work } from './schedules-harness.ts';

export const UUID: RegExp = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;

/**
 * The wording rule: every identifier and every number a refusal carries is one
 * the caller sent. Returns what the refusal names that the request did not.
 */
export function unsent(refusal: unknown, request: unknown): readonly string[] {
  const sent = JSON.stringify(request).toLowerCase();
  const text = JSON.stringify(refusal).toLowerCase();
  const ids = text.match(UUID) ?? [];
  const numbers = text.replaceAll(UUID, ' ').match(/\b\d+\b/gu) ?? [];
  const sentNumbers = new Set(sent.replaceAll(UUID, ' ').match(/\b\d+\b/gu) ?? []);
  return [...ids.filter((id) => !sent.includes(id)), ...numbers.filter((n) => !sentNumbers.has(n))];
}

/** Which side of the order a statement locks on, or null when it locks nothing. */
export function classify(statement: { text: string; key: unknown }): 'command' | 'ordered' | null {
  if (statement.text.includes('pg_advisory_xact_lock')) {
    return /^[0-9a-f-]{36}:/u.test(String(statement.key)) ? 'ordered' : 'command';
  }
  if (
    /^select 1 from public\.\w+ where business_id = \$1 and id = \$2 for update$/u.test(
      statement.text,
    )
  )
    return 'ordered';
  if (/from records where .*for update/u.test(statement.text)) return 'command';
  return null;
}

export type Party = {
  readonly id: BusinessId;
  readonly member: Member;
  readonly tasks: { readonly id: string; readonly title: string; readonly client: Member }[];
};

/** The lease's holder and delegation, as the runtime is called with them. */
export interface LeaseOwner {
  readonly holder_actor_id: string;
  readonly delegation_id: string;
}

/** The helpers, bound to one schedules world. */
export interface Cq8World {
  command(
    business: BusinessId,
    who: Member,
    body: object,
    db?: Database,
  ): ReturnType<typeof executeCommand>;
  read(business: BusinessId, who: Member, body: object): ReturnType<typeof executeRead>;
  client(id: BusinessId, member: Member, key: string, recordId: string): Promise<Member>;
  party(key: string): Promise<Party>;
  reach(p: Party, taskId: string, parentId: string, who: Member): Promise<string>;
  owner(work: Work): Promise<LeaseOwner>;
  beat(
    business: string,
    leaseId: string,
    fence: number,
    who: LeaseOwner,
  ): ReturnType<typeof heartbeat>;
  giveBack(
    business: string,
    leaseId: string,
    fence: number,
    actorId: string,
  ): ReturnType<typeof handback>;
  revisionOfIn(business: BusinessId, recordId: string): Promise<number>;
}

export function cq8World(s: Schedules): Cq8World {
  const command = async (business: BusinessId, who: Member, body: object, db?: Database) =>
    await executeCommand(db ?? s.db.app, business, who.presented, 'api', {
      operationId: randomUUID(),
      ...body,
    } as never);
  const read = async (business: BusinessId, who: Member, body: object) =>
    await executeRead(s.db.app, business, who.presented, body as never);

  /** A client outside the business, on the one task the member shares with them. */
  async function client(id: BusinessId, member: Member, key: string, recordId: string) {
    const subject = `${key}-${randomUUID()}`;
    return await s.db.app.withBusiness(id, async (tx): Promise<Member> => {
      const personId = await insertPerson(tx, key);
      const actorId = await insertActor(tx, personId);
      await insertMapping(tx, await insertLogin(tx, subject), personId, member.actorId);
      const sharer = { personId: member.personId, actorId: member.actorId };
      const shared = await shareRecord(tx, sharer, { collection: 'task', recordId, personId });
      if (!shared.ok) throw new Error(`share refused ${shared.refusal.code}`);
      return { personId, actorId, presented: { provider: 'supabase', subject } };
    });
  }

  /** Two businesses, two clients each on one shared task, one grant each. */
  async function party(key: string): Promise<Party> {
    const id = (await insertBusiness(s.db.app, key)) as BusinessId;
    await installSpine(s.db.app, id);
    const member = await enrol(s.db.app, id, `${key}-member`);
    await s.db.app.withBusiness(id, async (tx) => {
      await grantTo(tx, member, 'write');
      await grantTo(tx, member, 'read');
      await grantTo(tx, member, 'share');
    });
    const tasks: Party['tasks'] = [];
    for (const n of [1, 2]) {
      const title = `cq8-${key}-${String(n)}-${randomUUID()}`;
      // eslint-disable-next-line no-await-in-loop
      const made = await command(id, member, { command: 'task.create', fields: { title } });
      if (isCommandRefusal(made)) throw new Error(`task.create refused ${made.code}`);
      const recordId = String(made.recordId);
      // eslint-disable-next-line no-await-in-loop
      const shared = await client(id, member, `${key}-c${n}`, recordId);
      tasks.push({ id: recordId, title, client: shared });
    }
    return { id, member, tasks };
  }

  /** Every locked path the ticket moved, as `who`, against `task`, answered as one string. */
  const reach = async (p: Party, taskId: string, parentId: string, who: Member) =>
    JSON.stringify([
      await read(p.id, who, { read: 'task.read', recordId: taskId }),
      await command(p.id, who, {
        command: 'task.reparent',
        recordId: taskId,
        expectedRevision: 1,
        parentId,
      }),
      await command(p.id, who, {
        command: 'task.rank',
        recordId: taskId,
        expectedRevision: 1,
        afterId: null,
        beforeId: null,
      }),
    ]);

  /** The lease's owner as the runtime sees it, for calling the transactions directly. */
  async function owner(work: Work): Promise<LeaseOwner> {
    const found = await rows<LeaseOwner>(
      s,
      `select holder_actor_id, delegation_id from public.leases where business_id = $1 and id = $2`,
      [s.business, work.picked['leaseId']],
    );
    const row = found[0];
    if (row === undefined) throw new Error('no lease');
    return row;
  }

  const beat = (
    business: string,
    leaseId: string,
    fence: number,
    who: { holder_actor_id: string; delegation_id: string },
  ) =>
    s.db.app.withBusiness(business, (tx: TenantQuery) =>
      heartbeat(tx, {
        claimant: 'agent',
        leaseId,
        fence,
        holderActorId: who.holder_actor_id,
        delegationId: who.delegation_id,
        renewSeconds: 60,
      }),
    );
  const giveBack = (business: string, leaseId: string, fence: number, actorId: string) =>
    s.db.app.withBusiness(business, (tx: TenantQuery) =>
      handback(tx, {
        leaseId,
        fence,
        outcome: 'completed',
        report: { summary: 'cq8' },
        actualMinor: null,
        holder: { claimant: 'agent', actorId },
      }),
    );

  async function revisionOfIn(business: BusinessId, recordId: string): Promise<number> {
    const found = await rows<{ r: string }>(
      s,
      `select revision::text as r from public.records where business_id = $1 and id = $2`,
      [business, recordId],
    );
    return Number(found[0]?.r ?? 0);
  }

  return { command, read, client, party, reach, owner, beat, giveBack, revisionOfIn };
}
