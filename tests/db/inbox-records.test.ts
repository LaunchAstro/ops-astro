// SPDX-License-Identifier: AGPL-3.0-only
//
// INB-1 three records (INB-1a, supporting checklist lines C1 and C2): the fact,
// the recipient's inbox item and its delivery attempts are three records and
// never one, and an item has four axes with access derived at every read.
//
// The item is a pointer: its columns are named here exactly, so a fact column
// copied onto it (a title, a body, a state) turns this red. Attempts live in
// their own table and never move the item. Access has no column anywhere; it is
// read from the recipient's live grants and the task, so a lost grant withholds
// the item and a trashed task makes it gone, and neither deletes it.
//
// The three separations run here too: business to business (row security),
// client to client inside one business (a party-scoped grant reaches its own
// client's task only) and person to person (one recipient's read never returns
// another's item, and an attention row names the item's own recipient or fails).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueGrant, revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import {
  raiseInboxItem,
  readInboxItems,
  recordDeliveryAttempt,
} from '../../packages/core-records/src/index.ts';
import { installTaskSpine } from '../../packages/core-records/src/tasks/install.ts';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import {
  insertActor,
  insertAgentActor,
  insertBusiness,
  insertPerson,
} from '../identity/fixture.ts';
import { createTask } from '../tasks/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const ITEM_COLUMNS = [
  'business_id',
  'closed_at',
  'closed_by_operation_id',
  'closed_by_person_id',
  'fact_id',
  'fact_kind',
  'id',
  'owed',
  'raised_at',
  'reason',
  'recipient_person_id',
  'subject_record_id',
  'work_state',
];

describe.skipIf(serverUrl === undefined)('INB-1 three records', () => {
  let db: FreshDatabase;
  let alpha: string;
  let bravo: string;
  let ada: string;
  let bea: string;
  let adaActor: string;
  let clientA: string;
  let taskA: string;
  let taskB: string;

  const columnsOf = async (table: string): Promise<readonly string[]> => {
    const rows = await db.admin.execute<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = $1 order by column_name`,
      [table],
    );
    return rows.map((row) => row.column_name);
  };

  const inAlpha = async <T>(work: (tx: TenantQuery) => Promise<T>): Promise<T> =>
    await db.app.withBusiness(alpha, work);

  const grantRead = async (scope: { kind: 'record' | 'party'; id: string }): Promise<string> =>
    await inAlpha(async (tx) => {
      const issued = await issueGrant(tx, [], {
        subject: { kind: 'person', id: ada },
        scope,
        collection: 'task',
        action: 'read',
        parentGrantId: null,
        grantedByActorId: adaActor,
      });
      if (!issued.ok) throw new Error('grantRead: refused');
      return issued.value;
    });

  const accessOf = async (person: string, item: string): Promise<string | undefined> =>
    await inAlpha(
      async (tx) => (await readInboxItems(tx, person)).find((x) => x.id === item)?.access,
    );

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'inb1a' });
    alpha = await insertBusiness(db.app, 'alpha');
    bravo = await insertBusiness(db.app, 'bravo');
    clientA = randomUUID();
    await inAlpha(async (tx) => {
      const spine = await installTaskSpine(tx);
      ada = await insertPerson(tx, 'Ada');
      bea = await insertPerson(tx, 'Bea');
      adaActor = await insertActor(tx, ada);
      taskA = await createTask(tx, spine, { title: 'client A work', parentId: null });
      taskB = await createTask(tx, spine, { title: 'client B work', parentId: null });
      const set = `update public.records set data = data || jsonb_build_object('client', $2::text)
                    where business_id = $1 and id = $3`;
      await tx.query(set, [tx.businessId, clientA, taskA]);
      await tx.query(set, [tx.businessId, randomUUID(), taskB]);
    });
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('keeps the item a pointer: no fact column is copied onto it', async () => {
    expect(await columnsOf('inbox_items')).toStrictEqual(ITEM_COLUMNS);
  });

  it('keeps attempts and attention apart from the item, and access in no column', async () => {
    expect(await columnsOf('inbox_delivery_attempts')).toStrictEqual([
      'business_id',
      'channel',
      'evidence',
      'id',
      'item_id',
      'observed_at',
      'observed_seq',
      'state',
    ]);
    expect(await columnsOf('inbox_attention')).toStrictEqual([
      'business_id',
      'item_id',
      'person_id',
      'seen_at',
    ]);
    const access = await db.admin.execute(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'public' and table_name like 'inbox%' and column_name like '%access%'`,
    );
    expect([...access]).toStrictEqual([]);
  });

  it('records an attempt without moving the item, and the application cannot rewrite one', async () => {
    const item = await inAlpha(
      async (tx) =>
        await raiseInboxItem(tx, {
          recipientPersonId: ada,
          subjectRecordId: taskA,
          reason: 'assignment',
          fact: { kind: 'record', id: taskA },
        }),
    );
    const itemRow = async (): Promise<unknown> =>
      await db.admin.execute('select * from public.inbox_items where id = $1', [item]);
    const before = await itemRow();
    await inAlpha(async (tx) => {
      await recordDeliveryAttempt(tx, { itemId: item, channel: 'in_app', state: 'asked' });
    });
    const after = await itemRow();
    expect(after).toStrictEqual(before);
    const read = await inAlpha(async (tx) => await readInboxItems(tx, ada));
    expect(read.find((x) => x.id === item)?.lastDelivery).toBe('asked');
    await expect(
      inAlpha(
        async (tx) =>
          await tx.query(`update public.inbox_delivery_attempts set state = 'delivered'`),
      ),
    ).rejects.toThrow(/permission denied/u);
    await expect(
      inAlpha(async (tx) => await tx.query('delete from public.inbox_delivery_attempts')),
    ).rejects.toThrow(/permission denied/u);
  });

  it('raises one open item per recipient, subject, reason and fact', async () => {
    const raise = async (): Promise<string> =>
      await inAlpha(
        async (tx) =>
          await raiseInboxItem(tx, {
            recipientPersonId: bea,
            subjectRecordId: taskB,
            reason: 'mention',
            fact: { kind: 'record', id: taskB },
          }),
      );
    expect(await raise()).toBe(await raise());
  });

  it('derives access at every read: withheld on a lost grant, gone on a trashed task still readable, and never deleted', async () => {
    const task = await inAlpha(async (tx) => {
      const spine = await installTaskSpine(tx);
      return await createTask(tx, spine, { title: 'lost then gone', parentId: null });
    });
    const item = await inAlpha(
      async (tx) =>
        await raiseInboxItem(tx, {
          recipientPersonId: ada,
          subjectRecordId: task,
          reason: 'decision',
          fact: { kind: 'gate', id: randomUUID() },
        }),
    );
    expect(await accessOf(ada, item)).toBe('withheld');
    const grant = await grantRead({ kind: 'record', id: task });
    expect(await accessOf(ada, item)).toBe('readable');
    await inAlpha(async (tx) => {
      await revokeGrant(tx, grant);
    });
    expect(await accessOf(ada, item)).toBe('withheld');
    await inAlpha(async (tx) => {
      await tx.query(
        `update public.records set deleted_at = now(), deleted_by_actor_id = $2, trash_batch_id = $3
          where business_id = $1 and id = $4`,
        [tx.businessId, adaActor, randomUUID(), task],
      );
    });
    // Without read, a trashed task stays withheld: gone would tell a stranger it
    // existed (INB-1d, Sol review 1). With read again, it is gone.
    expect(await accessOf(ada, item)).toBe('withheld');
    await grantRead({ kind: 'record', id: task });
    expect(await accessOf(ada, item)).toBe('gone');
  });

  it('separates client from client: a party grant reaches its own client only', async () => {
    const raise = async (subject: string): Promise<string> =>
      await inAlpha(
        async (tx) =>
          await raiseInboxItem(tx, {
            recipientPersonId: ada,
            subjectRecordId: subject,
            reason: 'mention',
            fact: { kind: 'record', id: subject },
          }),
      );
    const onA = await raise(taskA);
    const onB = await raise(taskB);
    await grantRead({ kind: 'party', id: clientA });
    expect(await accessOf(ada, onA)).toBe('readable');
    expect(await accessOf(ada, onB)).toBe('withheld');
  });

  it('Sol proof, criterion 3: withheld client pointers are redacted', async () => {
    await grantRead({ kind: 'party', id: clientA });
    const hiddenItem = await inAlpha(
      async (tx) =>
        await raiseInboxItem(tx, {
          recipientPersonId: ada,
          subjectRecordId: taskB,
          reason: 'incident',
          fact: { kind: 'record', id: taskB },
        }),
    );
    const read = await inAlpha(async (tx) => await readInboxItems(tx, ada));
    const withheld = read.find((item) => item.id === hiddenItem);
    expect(withheld?.access).toBe('withheld');
    expect(withheld).not.toHaveProperty('subjectRecordId');
    expect(withheld).not.toHaveProperty('factId');
  });

  it('Sol proof, criterion 3: withheld client decider identity is redacted', async () => {
    await grantRead({ kind: 'party', id: clientA });
    await inAlpha(async (tx) => {
      const [task] = await tx.query<{ readonly clientId: string }>(
        `select uuid_7 as "clientId" from public.records where business_id = $1 and id = $2`,
        [tx.businessId, taskB],
      );
      if (task === undefined) throw new Error('client B task missing');
      const granted = await issueGrant(tx, [], {
        subject: { kind: 'person', id: bea },
        scope: { kind: 'party', id: task.clientId },
        collection: 'task',
        action: 'read',
        parentGrantId: null,
        grantedByActorId: adaActor,
      });
      if (!granted.ok) throw new Error('client B reviewer grant refused');
    });
    const hiddenItem = await inAlpha(
      async (tx) =>
        await raiseInboxItem(tx, {
          recipientPersonId: ada,
          subjectRecordId: taskB,
          reason: 'decision',
          fact: { kind: 'gate', id: randomUUID() },
        }),
    );
    await inAlpha(async (tx) => {
      await tx.query(
        `update public.inbox_items
            set work_state = 'cleared', closed_at = now(), closed_by_person_id = $3
          where business_id = $1 and id = $2`,
        [tx.businessId, hiddenItem, bea],
      );
    });
    const read = await inAlpha(async (tx) => await readInboxItems(tx, ada));
    const withheld = read.find((item) => item.id === hiddenItem);
    expect(withheld?.access).toBe('withheld');
    expect(withheld).not.toHaveProperty('closedByPersonId');
  });

  it('Sol proof, criterion 5: delivery observations read in causal order', async () => {
    const item = await inAlpha(
      async (tx) =>
        await raiseInboxItem(tx, {
          recipientPersonId: ada,
          subjectRecordId: taskA,
          reason: 'incident',
          fact: { kind: 'record', id: taskA },
        }),
    );
    await inAlpha(async (tx) => {
      await tx.query(
        `insert into public.inbox_delivery_attempts
           (business_id, id, item_id, channel, state)
         values ($1, 'ffffffff-ffff-4fff-8fff-ffffffffffff', $2, 'in_app', 'asked')`,
        [tx.businessId, item],
      );
      await tx.query(
        `insert into public.inbox_delivery_attempts
           (business_id, id, item_id, channel, state)
         values ($1, '00000000-0000-4000-8000-000000000001', $2, 'in_app', 'accepted')`,
        [tx.businessId, item],
      );
    });
    const read = await inAlpha(async (tx) => await readInboxItems(tx, ada));
    expect(read.find((candidate) => candidate.id === item)?.lastDelivery).toBe('accepted');
  });

  it('separates an external client: a share reaches its own task, and a canary id never shows', async () => {
    const [cleo, cleoActor] = await inAlpha(async (tx) => {
      const person = await insertPerson(tx, 'Cleo, an outside client');
      return [person, await insertActor(tx, person)] as const;
    });
    await inAlpha(async (tx) => {
      const shared = await issueGrant(tx, [], {
        subject: { kind: 'person', id: cleo },
        scope: { kind: 'record', id: taskA },
        collection: 'task',
        action: 'read',
        parentGrantId: null,
        grantedByActorId: cleoActor,
      });
      if (!shared.ok) throw new Error('share refused');
    });
    const raise = async (subject: string): Promise<string> =>
      await inAlpha(
        async (tx) =>
          await raiseInboxItem(tx, {
            recipientPersonId: cleo,
            subjectRecordId: subject,
            reason: 'client_comment',
            fact: { kind: 'record', id: subject },
          }),
      );
    const onShared = await raise(taskA);
    const onOther = await raise(taskB);
    // A staff reviewer on the other task clears it, so the item holds their identity.
    await inAlpha(async (tx) => {
      await tx.query(
        `update public.inbox_items
            set work_state = 'cleared', closed_at = now(), closed_by_person_id = $3
          where business_id = $1 and id = $2`,
        [tx.businessId, onOther, bea],
      );
    });
    const read = await inAlpha(async (tx) => await readInboxItems(tx, cleo));
    expect(read.find((item) => item.id === onShared)?.access).toBe('readable');
    const withheld = read.find((item) => item.id === onOther);
    expect(withheld?.access).toBe('withheld');
    // Every field a withheld item carries, named: a new identity or pointer
    // field goes red here until it is placed on the readable side.
    expect(Object.keys(withheld ?? {}).toSorted()).toStrictEqual([
      'access',
      'closedAt',
      'factKind',
      'id',
      'lastDelivery',
      'owed',
      'raisedAt',
      'reason',
      'recipientPersonId',
      'seenAt',
      'workState',
    ]);
    // The canaries: the other task's id and its reviewer's id appear nowhere in the read.
    expect(JSON.stringify(read)).not.toContain(taskB);
    expect(JSON.stringify(read)).not.toContain(bea);
  });

  it('crosses no delegation: an agent acting for the recipient lends them no read', async () => {
    const task = await inAlpha(async (tx) => {
      const spine = await installTaskSpine(tx);
      return await createTask(tx, spine, { title: 'the agent may read this', parentId: null });
    });
    await inAlpha(async (tx) => {
      const agent = await insertAgentActor(tx);
      await tx.query(
        `insert into public.delegations
           (business_id, id, agent_actor_id, delegate_person_id, minted_by_actor_id, purpose,
            collections, actions, credential_hash, expires_at, purpose_scope_kind, purpose_scope_id)
         values ($1, gen_random_uuid(), $2, $3, $4, 'inbox_crossing', array['task'], array['read'],
                 $5, now() + interval '1 hour', 'record', $6)`,
        [tx.businessId, agent, ada, adaActor, 'a'.repeat(64), task],
      );
      const granted = await issueGrant(tx, [], {
        subject: { kind: 'actor', id: agent },
        scope: { kind: 'record', id: task },
        collection: 'task',
        action: 'read',
        parentGrantId: null,
        grantedByActorId: adaActor,
      });
      if (!granted.ok) throw new Error('agent grant refused');
    });
    const item = await inAlpha(
      async (tx) =>
        await raiseInboxItem(tx, {
          recipientPersonId: ada,
          subjectRecordId: task,
          reason: 'waiting_run',
          fact: { kind: 'record', id: task },
        }),
    );
    const read = await inAlpha(async (tx) => await readInboxItems(tx, ada));
    const withheld = read.find((candidate) => candidate.id === item);
    expect(withheld?.access).toBe('withheld');
    expect(JSON.stringify(withheld)).not.toContain(task);
  });

  it('raises once when two transitions raise the same item at the same time', async () => {
    const item = {
      recipientPersonId: bea,
      subjectRecordId: taskA,
      reason: 'assignment',
      fact: { kind: 'record', id: randomUUID() },
    } as const;
    // The first holds its uncommitted insert open; the second waits on the
    // one-open index, then finds the committed item rather than raising another.
    const first = inAlpha(async (tx) => {
      const id = await raiseInboxItem(tx, item);
      await tx.query('select pg_sleep(0.5)');
      return id;
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
    const second = inAlpha(async (tx) => await raiseInboxItem(tx, item));
    const [one, two] = await Promise.all([first, second]);
    expect(two).toBe(one);
    const rows = await db.admin.execute('select id from public.inbox_items where fact_id = $1', [
      item.fact.id,
    ]);
    expect(rows.length).toBe(1);
  });

  it('separates person from person: a read is the recipient own, and so is attention', async () => {
    const beas = await inAlpha(async (tx) => await readInboxItems(tx, bea));
    expect(beas.length).toBeGreaterThan(0);
    const adas = await inAlpha(async (tx) => await readInboxItems(tx, ada));
    expect(adas.filter((item) => beas.some((other) => other.id === item.id))).toStrictEqual([]);
    const beaItem = beas[0]?.id;
    await expect(
      inAlpha(
        async (tx) =>
          await tx.query(
            'insert into public.inbox_attention (business_id, item_id, person_id) values ($1, $2, $3)',
            [tx.businessId, beaItem, ada],
          ),
      ),
    ).rejects.toThrow(/inbox_attention_recipient_fkey/u);
  });

  it('separates business from business: another business reads none and writes none', async () => {
    const seen = await db.app.withBusiness(
      bravo,
      async (tx) => await tx.query('select id from public.inbox_items'),
    );
    expect([...seen]).toStrictEqual([]);
    await expect(
      db.app.withBusiness(
        bravo,
        async (tx) =>
          await tx.query(
            `insert into public.inbox_items
             (business_id, id, recipient_person_id, subject_record_id, reason, fact_kind, fact_id)
           values ($1, gen_random_uuid(), $2, $3, 'mention', 'record', $3)`,
            [alpha, ada, taskA],
          ),
      ),
    ).rejects.toThrow(/row-level security/u);
  });
});
