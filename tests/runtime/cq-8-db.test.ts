// SPDX-License-Identifier: AGPL-3.0-only
//
// CQ-8 against a real database: the lease refusals follow one wording rule,
// the command layer's locks come before any lock `acquire` takes, and moving
// every advisory lock to one helper carries nothing across a business, a
// client or a person.
//
// Every operation goes through the production command entry or the runtime's
// own exported transaction, never a hand-written statement standing in for it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  connectObserved,
  type BusinessId,
  type Database,
  type ObservedPool,
  type TenantQuery,
} from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
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
import {
  approve,
  asPerson,
  createTask,
  liveWork,
  openSchedules,
  pickup,
  propose,
  revisionOf,
  rows,
  type Schedules,
  type Work,
} from './schedules-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/cq-8-db: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;

/**
 * The wording rule: every identifier and every number a refusal carries is one
 * the caller sent. Returns what the refusal names that the request did not.
 */
function unsent(refusal: unknown, request: unknown): readonly string[] {
  const sent = JSON.stringify(request).toLowerCase();
  const text = JSON.stringify(refusal).toLowerCase();
  const ids = text.match(UUID) ?? [];
  const numbers = text.replaceAll(UUID, ' ').match(/\b\d+\b/gu) ?? [];
  const sentNumbers = new Set(sent.replaceAll(UUID, ' ').match(/\b\d+\b/gu) ?? []);
  return [...ids.filter((id) => !sent.includes(id)), ...numbers.filter((n) => !sentNumbers.has(n))];
}

/** Which side of the order a statement locks on, or null when it locks nothing. */
function classify(statement: { text: string; key: unknown }): 'command' | 'ordered' | null {
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

type Party = {
  readonly id: BusinessId;
  readonly member: Member;
  readonly tasks: { readonly id: string; readonly title: string; readonly client: Member }[];
};

describe.skipIf(serverUrl === undefined)('CQ-8 on a real database', () => {
  let s: Schedules;
  let bravo: Party;
  let charlie: Party;

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
  async function owner(work: Work) {
    const found = await rows<{ readonly holder_actor_id: string; readonly delegation_id: string }>(
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

  beforeAll(async () => {
    s = await openSchedules('cq8', 1_000_000);
    bravo = await party('bravo');
    charlie = await party('charlie');
  }, 180_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  it('CQ-8 lease refusal wording: heartbeat and handback give one reason per cause and echo nothing the caller did not send', async () => {
    const work = await liveWork(s, `cq8-wording-${randomUUID()}`, 1_000);
    const who = await owner(work);
    const leaseId = String(work.picked['leaseId']);
    const fence = Number(work.picked['fence']);
    const made = randomUUID();

    const answers = {
      fabricated: [
        await beat(s.business, made, fence, who),
        await giveBack(s.business, made, fence, who.holder_actor_id),
      ],
      wrongFence: [
        await beat(s.business, leaseId, fence + 7, who),
        await giveBack(s.business, leaseId, fence + 7, who.holder_actor_id),
      ],
    };
    // Past its expiry on the database clock, still live in state.
    await s.db.admin.execute(
      `update public.leases set expires_at = now() - interval '1 second' where business_id = $1 and id = $2`,
      [s.business, leaseId],
    );
    const expired = [
      await beat(s.business, leaseId, fence, who),
      await giveBack(s.business, leaseId, fence, who.holder_actor_id),
    ];

    const cases = [
      ['fabricated', answers.fabricated, 'LEASE_NOT_OWNED', { leaseId: made, fence }],
      ['wrong fence', answers.wrongFence, 'LEASE_NOT_OWNED', { leaseId, fence: fence + 7 }],
      ['expired', expired, 'LEASE_EXPIRED', { leaseId, fence }],
    ] as const;
    for (const [name, [renewed, handed], code, sent] of cases) {
      if (renewed === undefined || handed === undefined || renewed.ok || handed.ok)
        throw new Error(`${name}: a lease call was not refused`);
      expect(renewed.refusal.code, name).toBe(code);
      expect(handed.refusal.code, name).toBe(code);
      // One rule: the same cause is the same reason from both operations.
      expect(handed.refusal.fixes[0], name).toBe(renewed.refusal.fixes[0]);
      expect(unsent(renewed.refusal, sent), name).toEqual([]);
      expect(unsent(handed.refusal, sent), name).toEqual([]);
    }
    // A foreign lease and a made-up one are the same bytes, whatever was sent.
    expect(JSON.stringify(answers.fabricated[0]).replaceAll(made, 'L')).not.toContain(leaseId);
  });

  it('CQ-8 command locks first: in every transaction the command layer locks before any lock acquire takes', async () => {
    const seen: { readonly text: string; readonly key: unknown }[][] = [];
    const recording: Database = {
      ...s.db.app,
      withBusiness: async (business, run) =>
        await s.db.app.withBusiness(business, async (tx) => {
          const statements: { text: string; key: unknown }[] = [];
          seen.push(statements);
          return await run({
            businessId: tx.businessId,
            query: async (text, parameters = []) => {
              statements.push({ text: text.replaceAll(/\s+/gu, ' ').trim(), key: parameters[0] });
              return await tx.query(text, parameters);
            },
          });
        }),
    };
    const parent = await createTask(s, `cq8-parent-${randomUUID()}`);
    const child = await createTask(s, `cq8-child-${randomUUID()}`);
    await asPerson(
      s,
      {
        command: 'task.reparent',
        operationId: randomUUID(),
        recordId: child,
        expectedRevision: await revisionOf(s, child),
        parentId: parent,
      },
      recording,
    );
    await asPerson(
      s,
      {
        command: 'task.rank',
        operationId: randomUUID(),
        recordId: child,
        expectedRevision: await revisionOf(s, child),
        afterId: null,
        beforeId: null,
      },
      recording,
    );
    const proposal = await propose(s, parent, { maximumMinor: 500 });
    const decided = await approve(s, proposal);
    await pickup(s, decided['reservationId']);

    let commandLocks = 0;
    for (const statements of seen) {
      const kinds = statements.map(classify);
      const lastCommand = kinds.lastIndexOf('command');
      const firstOrdered = kinds.indexOf('ordered');
      commandLocks += kinds.filter((kind) => kind === 'command').length;
      if (lastCommand >= 0 && firstOrdered >= 0) expect(lastCommand).toBeLessThan(firstOrdered);
    }
    expect(commandLocks).toBeGreaterThanOrEqual(3);
  });

  it('CQ-8 pooled crossover: after the locks moved, a pooled backend carries no business and no lock into the next request', async () => {
    const pool: ObservedPool = connectObserved(s.db.appUrl, { source: 'runtime', max: 1 });
    try {
      const pid = async () =>
        Number(
          (await pool.betweenTransactions<{ pid: number }>('select pg_backend_pid() as pid'))[0]
            ?.pid,
        );
      const between = async () => ({
        setting:
          (
            await pool.betweenTransactions<{ value: string | null }>(
              `select current_setting('app.business_id', true) as value`,
            )
          )[0]?.value ?? '',
        advisory: Number(
          (
            await pool.betweenTransactions<{ n: string }>(
              `select count(*)::text as n from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()`,
            )
          )[0]?.n,
        ),
        records: Number(
          (
            await pool.betweenTransactions<{ n: string }>('select count(*)::text as n from records')
          )[0]?.n,
        ),
      });
      const backend = await pid();
      const [one, two] = bravo.tasks as [Party['tasks'][number], Party['tasks'][number]];
      // The placement and sibling locks, through the one helper, on bravo.
      const moved = await command(
        bravo.id,
        bravo.member,
        {
          command: 'task.reparent',
          recordId: two.id,
          expectedRevision: await revisionOfIn(bravo.id, two.id),
          parentId: one.id,
        },
        pool,
      );
      expect(isCommandRefusal(moved)).toBe(false);
      expect(await pid()).toBe(backend);
      expect(await between()).toEqual({ setting: '', advisory: 0, records: 0 });

      // Charlie next on the same backend: its own rows, none of bravo's.
      const made = await command(
        charlie.id,
        charlie.member,
        { command: 'task.create', fields: { title: `cq8-pool-${randomUUID()}` } },
        pool,
      );
      expect(isCommandRefusal(made)).toBe(false);
      expect(await pid()).toBe(backend);
      const titles = await pool.withBusiness(charlie.id, async (tx) =>
        (await tx.query<{ t: string }>(`select data->>'title' as t from records`)).map((r) => r.t),
      );
      for (const task of bravo.tasks) expect(titles).not.toContain(task.title);
      expect(await between()).toEqual({ setting: '', advisory: 0, records: 0 });
    } finally {
      await pool.close();
    }
  });

  async function revisionOfIn(business: BusinessId, recordId: string): Promise<number> {
    const found = await rows<{ r: string }>(
      s,
      `select revision::text as r from public.records where business_id = $1 and id = $2`,
      [business, recordId],
    );
    return Number(found[0]?.r ?? 0);
  }

  it('CQ-8 cross-client refused: a client reaches its own task and another client is answered as a made-up id', async () => {
    for (const p of [bravo, charlie]) {
      const [one, two] = p.tasks as [Party['tasks'][number], Party['tasks'][number]];
      const ghost = randomUUID();
      // eslint-disable-next-line no-await-in-loop
      const own = await read(p.id, one.client, { read: 'task.read', recordId: one.id });
      expect(JSON.stringify(own)).toContain(one.title);
      // eslint-disable-next-line no-await-in-loop
      const other = await reach(p, two.id, one.id, one.client);
      // eslint-disable-next-line no-await-in-loop
      const none = await reach(p, ghost, one.id, one.client);
      expect(other.replaceAll(two.id, 'ID')).toBe(none.replaceAll(ghost, 'ID'));
      for (const leaked of [two.title, two.client.personId]) expect(other).not.toContain(leaked);
    }
  });

  it('CQ-8 isolation: business to business, client to client and person to person, through the locked paths and the lease', async () => {
    const work = await liveWork(s, `cq8-isolation-${randomUUID()}`, 1_000);
    const who = await owner(work);
    const leaseId = String(work.picked['leaseId']);
    const fence = Number(work.picked['fence']);
    const made = randomUUID();
    const both = async (business: string, id: string) => [
      await beat(business, id, fence, who),
      await giveBack(business, id, fence, who.holder_actor_id),
    ];
    for (const p of [bravo, charlie]) {
      // Another business's live lease is answered as a made-up one, in both operations.
      // oxlint-disable-next-line no-await-in-loop
      const [foreign, invented] = await Promise.all([both(p.id, leaseId), both(p.id, made)]);
      expect(JSON.stringify(foreign).replaceAll(leaseId, 'L')).toBe(
        JSON.stringify(invented).replaceAll(made, 'L'),
      );

      const [one, two] = p.tasks as [Party['tasks'][number], Party['tasks'][number]];
      // Person to person: a member with no grant is answered as for a made-up id.
      // eslint-disable-next-line no-await-in-loop
      const stranger = await enrol(s.db.app, p.id, `cq8-stranger-${randomUUID()}`);
      const ghost = randomUUID();
      // eslint-disable-next-line no-await-in-loop
      const theirs = await reach(p, two.id, one.id, stranger);
      // eslint-disable-next-line no-await-in-loop
      const nobody = await reach(p, ghost, one.id, stranger);
      expect(theirs.replaceAll(two.id, 'ID')).toBe(nobody.replaceAll(ghost, 'ID'));
      for (const leaked of [two.title, two.client.personId, p.member.personId])
        expect(theirs).not.toContain(leaked);
    }
    // Business to business: each side's member and clients reach the other's tasks
    // through the locked paths and see none of them, nor change them.
    for (const [from, to] of [
      [bravo, charlie],
      [charlie, bravo],
    ] as const) {
      for (const person of [from.member, ...from.tasks.map((t) => t.client)]) {
        for (const task of to.tasks) {
          // eslint-disable-next-line no-await-in-loop
          const answers = `${await reach(to, task.id, to.tasks[0]?.id ?? '', person)}${await reach(from, task.id, from.tasks[0]?.id ?? '', person)}`;
          expect(answers).not.toContain(task.title);
        }
      }
      for (const task of to.tasks) {
        // eslint-disable-next-line no-await-in-loop
        expect(await revisionOfIn(to.id, task.id)).toBeLessThanOrEqual(2);
      }
    }
  });
});
